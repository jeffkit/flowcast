// subflow.js — 子 flow 调度原语：让一条 flow（或外层脚本）能并发编排多条隔离的子 flow。
//
// 为什么是 flowcast 原语而不是裸 child_process：FLOW_API 契约禁止生成的 flow import child_process，
// 所以「一条 flow 起另一条 flow」必须由 flowcast 暴露受控原语来做（runFlow / fanOut），契约才不破。
//
// 三层进程链：外层（脚本/flow）→ runFlow spawn 出子 flow（独立 node 进程）→ 子 flow 内部再派 agent CLI。
// 续跑由子 flow 自身的 --run-id + Checkpoint 负责；worktree 隔离让并发子 flow 互不污染。

import { spawn } from 'child_process'
import { mkdirSync, openSync, closeSync, existsSync, cpSync } from 'fs'
import { assertSafeIdent } from './helpers.js'
import { dirname, join } from 'path'
import { gitWorktreeAdd, gitWorktreeRemove } from './git.js'
import { isDryRun } from './dry-run.js'
import { flowcastDir } from './dirs.js'

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
 * @param {boolean} [o.dryRun]     默认继承当前 isDryRun()；true 则加 --dry-run + FLOWCAST_DRY_RUN
 * @param {Function} [o.onData]    实时输出回调（仅在不写 logFile 时生效）
 * @param {string} [o.logFile]     给了则把 stdout/stderr 重定向到该文件（并发时避免终端交错）
 * @returns {Promise<{ok:boolean, exitCode:number|null, stdout:string, stderr:string, spawnError?:boolean}>}
 */
export function runFlow(flowRef, {
  repo, runId, goal, agent, args = [], cwd = repo,
  timeout, dryRun = isDryRun(), onData, logFile,
} = {}) {
  if (onData && logFile) {
    console.warn('[runFlow] onData 被忽略：同时指定了 logFile，子 flow 输出写入文件，onData 回调不生效')
  }
  return new Promise((resolve) => {
    const argv = [flowRef]
    if (runId) argv.push('--run-id', runId)
    if (repo) argv.push('--repo', repo)
    if (goal != null) argv.push('--goal', goal)
    if (agent) argv.push('--agent', agent)
    if (dryRun) argv.push('--dry-run')
    argv.push(...args)

    const env = { ...process.env }
    if (dryRun) env.FLOWCAST_DRY_RUN = '1'

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
    // 缓冲区上限 16 MB：与 spawn.js 保持一致，防止 verbose 子 flow 不指定 logFile 时
    // stdout 无限累积导致宿主 OOM（fanOut 通常指定 logFile；直接调用 runFlow 时不受保护）。
    const MAX_BUF = 16 * 1024 * 1024
    if (!logFile) {
      proc.stdout.on('data', d => {
        const s = String(d)
        onData?.(s)
        if (stdout.length < MAX_BUF) stdout += s
        else if (!stdout.endsWith('\n[output truncated]')) stdout += '\n[output truncated]'
      })
      proc.stderr.on('data', d => {
        const s = String(d)
        if (stderr.length < MAX_BUF) stderr += s
        else if (!stderr.endsWith('\n[output truncated]')) stderr += '\n[output truncated]'
      })
    }

    let timer
    let hardKillTimer
    if (timeout) timer = setTimeout(() => {
      // 先 SIGTERM：给子 flow 5 秒清理机会（flush Checkpoint / 写日志）。
      // 5 秒后 SIGKILL 兜底——与 spawn.js 的超时处理逻辑对齐（单一策略，易维护）。
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
      hardKillTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
      }, 5_000)
    }, timeout)
    // 父进程收到 SIGINT/SIGTERM 时主动 kill 子进程——避免父死了子 node 还在跑（连带 agent CLI）。
    // 真正的 SIGKILL 父进程救不了（信号处理器不跑），但子 node 默认会随父退出（除非 detached）。
    // 不设 detached，让 Node 默认父死子死。
    let sigForwarded = false
    const forwardSig = (sig) => {
      if (sigForwarded || proc.killed || proc.exitCode != null) return
      sigForwarded = true
      try { proc.kill(sig) } catch { /* already dead */ }
    }
    // 保存具名引用：process.removeListener 按引用比较，匿名函数每次创建都是新对象，
    // 必须用同一个函数引用才能真正移除——否则每次 runFlow 都会永久泄漏一个信号处理器。
    const onSigInt = () => forwardSig('SIGINT')
    const onSigTerm = () => forwardSig('SIGTERM')
    process.once('SIGINT', onSigInt)
    process.once('SIGTERM', onSigTerm)
    const done = (exitCode, extra = {}) => {
      if (timer) clearTimeout(timer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
      process.removeListener('SIGINT', onSigInt)
      process.removeListener('SIGTERM', onSigTerm)
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
  cleanWorktrees = false,
} = {}) {
  const wtRoot = worktreesDir ?? join(repo, '.worktrees')
  const results = new Array(tasks.length)

  const runOne = async (task, idx) => {
    // task.name 是 worktree 路径与日志文件名的直接拼入部分。
    // path.join 会解析 `..`，不安全的名字会路径穿越。
    // 白名单字符校验拦在源头（与 helpers.assertSafeIdent 一致）。
    try {
      assertSafeIdent(task.name, 'task.name')
    } catch (e) {
      throw new Error(`fanOut: ${e.message}`)
    }
    let cwd = task.cwd ?? repo
    let worktree
    if (isolate === 'worktree' && !dryRun) {
      const dir = join(wtRoot, task.name)
      try {
        gitWorktreeAdd(repo, dir)
        worktree = dir
        cwd = dir
      } catch (e) {
        // worktree 创建失败时不能静默降级到主 repo——并发任务会互相污染，直接抛错
        throw new Error(`fanOut: 任务 '${task.name}' 建 worktree 失败（${e.message}）；` +
          `请用 isolate='none' 或修复 git worktree 环境`)
      }
    }
    if (prepare) await prepare(task, { cwd, worktree })
    const logFile = logDir ? join(logDir, `${task.name}.log`) : undefined
    try {
      const result = await runFlow(task.flow, {
        repo: cwd, runId: task.runId ?? task.name, goal: task.goal, agent: task.agent,
        args: task.args ?? [], cwd, timeout, dryRun, logFile,
        onData: logFile ? undefined : onData,
      })
      const record = { task, result, worktree }
      results[idx] = record
      // onResult 先于 worktree 清理：调用方可在此 archiveChildRun（从 worktree 镜像日志回主仓）。
      await onResult?.(record)
      return record
    } finally {
      // cleanWorktrees=true 时自动清理（避免孤儿堆积）；默认 false 保持旧行为，
      // 让调用方在 fanOut 返回后仍能访问 worktree 路径（如读取产物、归档）。
      if (worktree && cleanWorktrees) {
        try { gitWorktreeRemove(repo, worktree, { force: true }) } catch { /* 忽略清理失败 */ }
      }
    }
  }

  const limit = Math.max(1, Math.min(concurrency, tasks.length || 1))
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      const i = cursor++
      await runOne(tasks[i], i)
    }
  }

  // 每个并发子 flow 在 runFlow 里会各添加 2 个 process.once 监听器（SIGINT/SIGTERM）。
  // Node.js 默认 MaxListeners=10，高并发时会打 MaxListenersExceededWarning（不致命但噪音）。
  // 在 fanOut 期间动态提升上限，结束后恢复原值。
  const prevMaxListeners = process.getMaxListeners()
  const needed = limit * 2 + 10  // 每个子 flow 2 个 + 10 缓冲
  if (needed > prevMaxListeners) process.setMaxListeners(needed)
  try {
    await Promise.all(Array.from({ length: limit }, worker))
  } finally {
    process.setMaxListeners(prevMaxListeners)
  }
  return results
}

/**
 * 把 worktree 内某条子 run 的状态镜像回主仓 runs 目录（观测数据保全）。
 *
 * worktree 隔离的子 flow 把 state.json / run.log.jsonl 写在
 * `<worktree>/.flowcast/runs/<childRunId>`（或 .flowx/，由 flowcastDir 决定）。
 * worktree 会被后续 fanOut 复用或被清理，这些观测数据随之消失。
 * 每组完成后镜像回主仓 runs 目录，让看板（跨 worktree 采集）能在主仓一处稳定读到。
 * 纯保全操作，失败只告警、不影响主流程。
 *
 * @param {string} repo        主仓根目录（镜像目标）
 * @param {string} worktree    子 flow 的 worktree 路径（镜像来源；为空则跳过）
 * @param {string} childRunId  子 run 的 runId
 * @returns {boolean} 是否真的镜像了
 */
export function archiveChildRun(repo, worktree, childRunId) {
  if (!worktree || !childRunId) return false
  const src = join(flowcastDir(worktree), 'runs', childRunId)
  const dst = join(flowcastDir(repo), 'runs', childRunId)
  if (!existsSync(src) || src === dst) return false
  try {
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true })
    return true
  } catch (e) {
    console.warn(`  ⚠ 镜像子 run ${childRunId} 失败（忽略）：${e.message}`)
    return false
  }
}

// sweepStaleTmp 已迁移到 spawn.js（进程管理职责归属更合理）。
// 此处 re-export 保持向后兼容，防止已有调用方从 subflow.js 直接 import 的代码崩溃。
export { sweepStaleTmp } from './spawn.js'
