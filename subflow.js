// subflow.js — 子 flow 调度原语：让一条 flow（或外层脚本）能并发编排多条隔离的子 flow。
//
// 为什么是 flowx 原语而不是裸 child_process：FLOW_API 契约禁止生成的 flow import child_process，
// 所以「一条 flow 起另一条 flow」必须由 flowx 暴露受控原语来做（runFlow / fanOut），契约才不破。
//
// 三层进程链：外层（脚本/flow）→ runFlow spawn 出子 flow（独立 node 进程）→ 子 flow 内部再派 agent CLI。
// 续跑由子 flow 自身的 --run-id + Checkpoint 负责；worktree 隔离让并发子 flow 互不污染。

import { spawn } from 'child_process'
import { mkdirSync, openSync, closeSync } from 'fs'
import { dirname, join } from 'path'
import { gitWorktreeAdd } from './git.js'
import { isDryRun } from './dry-run.js'

/**
 * 把一个 flow 文件当独立 node 子进程跑（隔离 + 超时可控；崩溃不污染宿主）。
 * 只注入「调用方明确给了」的标准参数，避免污染不认识这些 flag 的 flow（如 force-dev 没有 --goal）。
 *
 * @param {string} flowRef  flow 文件路径
 * @param {object} [o]
 * @param {string} [o.repo]        传给子 flow 的 --repo
 * @param {string} [o.runId]       传给子 flow 的 --run-id（续跑锁定靠它）
 * @param {string} [o.goal]        非 null 才传 --goal
 * @param {string} [o.agent]       给了才传 --agent
 * @param {string[]} [o.args]      额外原样透传的 CLI 参数（如 --feature x --prompt-file p）
 * @param {string} [o.cwd]         子进程工作目录（默认 repo）
 * @param {number} [o.timeout]     超时 ms（到点 SIGKILL）
 * @param {boolean} [o.dryRun]     默认继承当前 isDryRun()；true 则加 --dry-run + FLOWX_DRY_RUN
 * @param {Function} [o.onData]    实时输出回调（仅在不写 logFile 时生效）
 * @param {string} [o.logFile]     给了则把 stdout/stderr 重定向到该文件（并发时避免终端交错）
 * @returns {Promise<{ok:boolean, exitCode:number|null, stdout:string, stderr:string, spawnError?:boolean}>}
 */
export function runFlow(flowRef, {
  repo, runId, goal, agent, args = [], cwd = repo,
  timeout, dryRun = isDryRun(), onData, logFile,
} = {}) {
  return new Promise((resolve) => {
    const argv = [flowRef]
    if (runId) argv.push('--run-id', runId)
    if (repo) argv.push('--repo', repo)
    if (goal != null) argv.push('--goal', goal)
    if (agent) argv.push('--agent', agent)
    if (dryRun) argv.push('--dry-run')
    argv.push(...args)

    const env = { ...process.env }
    if (dryRun) env.FLOWX_DRY_RUN = '1'

    let fd
    let stdio
    if (logFile) {
      mkdirSync(dirname(logFile), { recursive: true })
      fd = openSync(logFile, 'a')
      stdio = ['ignore', fd, fd]
    } else {
      stdio = ['ignore', 'pipe', 'pipe']
    }

    const proc = spawn('node', argv, { cwd, env, stdio })
    let stdout = ''
    let stderr = ''
    if (!logFile) {
      proc.stdout.on('data', d => { stdout += d; onData?.(String(d)) })
      proc.stderr.on('data', d => { stderr += d; onData?.(String(d)) })
    }

    let timer
    if (timeout) timer = setTimeout(() => proc.kill('SIGKILL'), timeout)
    const done = (exitCode, extra = {}) => {
      if (timer) clearTimeout(timer)
      if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr, ...extra })
    }
    proc.on('close', code => done(code))
    proc.on('error', err => done(null, { stderr: stderr + String(err), spawnError: true }))
  })
}

/**
 * 并发跑多个子 flow：限并发 + 可选 worktree 隔离 + 每任务日志 + 结果按序汇总。
 * 这是 todo-drain 那套「拆多组 → 各自跑 flow → 并发调度 → 隔离 → 汇总」的通用底座，
 * 手写编排与 L3 生成的任务清单共用它。checkpoint 记录交给调用方（用 cp.has 过滤、cp.record 回写）。
 *
 * @param {Array<{name:string, flow:string, runId?:string, goal?:string, agent?:string, args?:string[]}>} tasks
 * @param {object} [o]
 * @param {string} [o.repo]            主 repo（worktree 隔离基于它）
 * @param {number} [o.concurrency=1]   并发上限
 * @param {'worktree'|'none'} [o.isolate='none']  每任务隔离方式
 * @param {string} [o.worktreesDir]    worktree 根目录（默认 <repo>/.worktrees）
 * @param {number} [o.timeout]         每个子 flow 超时 ms
 * @param {boolean} [o.dryRun]         默认继承 isDryRun()
 * @param {string} [o.logDir]          给了则每任务输出写 <logDir>/<name>.log
 * @param {Function} [o.prepare]       隔离后、跑 flow 前的钩子 async (task, {cwd,worktree}) => void（如往 worktree 拷配置）
 * @param {Function} [o.onResult]      每个任务完成回调 async ({task,result,worktree}) => void
 * @returns {Promise<Array<{task:object, result:object, worktree?:string}>>}  按 tasks 原序
 */
export async function fanOut(tasks, {
  repo = process.cwd(), concurrency = 1, isolate = 'none',
  worktreesDir, timeout, dryRun = isDryRun(), logDir, prepare, onResult, onData,
} = {}) {
  const wtRoot = worktreesDir ?? join(repo, '.worktrees')
  const results = new Array(tasks.length)

  const runOne = async (task, idx) => {
    let cwd = task.cwd ?? repo
    let worktree
    if (isolate === 'worktree' && !dryRun) {
      const dir = join(wtRoot, task.name)
      try {
        gitWorktreeAdd(repo, dir)
        worktree = dir
        cwd = dir
      } catch (e) {
        console.warn(`  ⚠ ${task.name}: 建 worktree 失败，退回主 repo：${e.message}`)
      }
    }
    if (prepare) await prepare(task, { cwd, worktree })
    const logFile = logDir ? join(logDir, `${task.name}.log`) : undefined
    const result = await runFlow(task.flow, {
      repo: cwd, runId: task.runId ?? task.name, goal: task.goal, agent: task.agent,
      args: task.args ?? [], cwd, timeout, dryRun, logFile,
      onData: logFile ? undefined : onData,
    })
    const record = { task, result, worktree }
    results[idx] = record
    await onResult?.(record)
    return record
  }

  const limit = Math.max(1, Math.min(concurrency, tasks.length || 1))
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      const i = cursor++
      await runOne(tasks[i], i)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
