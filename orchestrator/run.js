// orchestrator/run.js — 执行生成的 flow（护栏③：子进程隔离 + 续跑锁定）

import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { generateFlow } from './generate.js'
import { decompose } from './decompose.js'
import { runFlow, fanOut } from '../subflow.js'
import { parallel } from '../concurrency.js'
import { flowcastDir } from '../dirs.js'

const FLOWCAST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 僵尸锁阈值：owner.json 记录 createdAt 超过此时长且 PID 已死则视为僵尸。
// 1 小时够长：常驻 CI runner 也不会比这更久；又够短：真正 SIGKILL 的活进程不会被误删。
const STALE_LOCK_MS = 60 * 60 * 1000
// lockDir 已存在但 owner.json 还没写的最长等待：10 次 × 100ms = 1s，给 owner 写盘留时间。
const LOCK_WAIT_TRIES = 10
const LOCK_WAIT_MS = 100

/**
 * 跑前预检：目标仓必须能解析到 flowcast，否则生成的 flow（import 本包）跑不起来。
 * 生成的 flow 住在 repo/.flowcast/runs/.../flow.mjs（或 legacy .flowx/runs/），ESM 裸解析从该文件向上走 node_modules，
 * 必经 repo/node_modules；用 repo 根的 require 解析做等价预检（向上能解析的它也能）。
 * 覆盖三种 OK 场景：repo 即本包（自引用）/ npm install / npm link（符号链接）。
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function checkFlowcastResolvable(repo) {
  try {
    createRequire(join(repo, '__flowcast_resolve_probe__.js')).resolve('flowcast')
    return { ok: true }
  } catch {
    return {
      ok: false,
      error: `目标仓无法解析 flowcast，生成的 flow 跑不起来。\n` +
        `请在目标仓安装本包后重试：\n` +
        `  cd ${repo} && npm install ${FLOWCAST_ROOT}\n` +
        `（或在其 package.json 加依赖 "flowcast": "file:${FLOWCAST_ROOT}"）`,
    }
  }
}

/**
 * 子进程隔离跑一个 flow 文件（`node <file> ...`）。隔离 + 超时可控 + 崩溃不污染宿主。
 * 现在委托给通用原语 runFlow（单一事实来源）；保留本签名/返回形状以兼容既有调用与测试。
 * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, spawnError?:boolean}>}
 */
export async function runGeneratedFlow(file, {
  repo, runId, goal, agent, extraArgs = [], dryRun = false, timeout, cwd = repo, onData,
} = {}) {
  const { ok, ...rest } = await runFlow(file, {
    repo, runId, goal, agent, args: extraArgs, dryRun, timeout, cwd, onData,
  })
  return rest
}

/**
 * 端到端编排：需求 →（生成 or 复用）→ 执行。
 * **续跑锁定**：run 目录已有 flow.mjs 则直接跑同一份，绝不重生成（保 resume 语义）。
 *
 * @param {string} request
 * @param {object} o  repo / runId / agent / agents / providers / generate / dryRun / timeout / onData / extraArgs
 *   - extraArgs  额外透传给生成 flow 子进程的 CLI 参数（如 --hitl wecom --project-name x）
 * @returns {Promise<object>} { ok, stage, file, reused, attempts, exitCode, stdout, stderr }
 */
export async function orchestrate(request, {
  repo = process.cwd(), runId = `orch-${Date.now()}`,
  agent, agents = {}, providers = {}, generate,
  dryRun = false, timeout, onData, extraArgs = [],
} = {}) {
  const dep = checkFlowcastResolvable(repo)
  if (!dep.ok) return { ok: false, stage: 'precheck', error: dep.error }

  const runDir = join(flowcastDir(repo), 'runs', runId)
  const file = join(runDir, 'flow.mjs')
  let reused = false
  let attempts = 0

  // 续跑锁定：用 mkdir -p 锁目录 + owner.json 替代旧「O_EXCL 创建 0-byte 文件」方案。
  // 旧方案把「独占锁刚拿但还没写内容」的合法中间态当成 0-byte 僵尸误删；
  // 新方案：lockDir 是锁的物理证据（不存在 = 空闲），owner.json 记 PID + 创建时间。
  // stale 判定：PID 已死 且 createdAt 超 STALE_LOCK_MS 才删（防误删刚 SIGKILL 活进程的锁）。
  mkdirSync(runDir, { recursive: true })
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const lockDir = join(runDir, '.lock')
    const claimed = await acquireLock(lockDir, runId, { allowReuse: true, producePath: file })
    if (claimed === 'reused') {
      reused = true
      break
    }
    if (claimed === null) {
      // stale 锁已清理 → 重试
      continue
    }
    if (claimed !== true) {
      // claimed 是 {pid,startedAt,runId}：别的活进程持有，抛错让外层决定（不偷偷重试）
      throw new Error(
        `orchestrate: runId=${runId} 正在被 pid=${claimed.pid} 执行` +
        `（startedAt=${new Date(claimed.startedAt).toISOString()}）。` +
        `如确认已死，可手动 rm -rf ${lockDir} 后重试。`,
      )
    }
    // 已独占锁，生成 flow
    try {
      const g = await generateFlow(request, { repo, runDir, agent, agents, providers, generate })
      attempts = g.attempts
      if (!g.validation.ok) {
        releaseLock(lockDir)
        return { ok: false, stage: 'generate', error: g.validation.error, file, attempts }
      }
      writeFileSync(join(runDir, 'request.txt'), request, 'utf8')
      releaseLock(lockDir)
      break
    } catch (e) {
      releaseLock(lockDir)
      throw e
    }
  }

  const res = await runGeneratedFlow(file, { repo, runId, goal: request, agent, dryRun, timeout, cwd: repo, onData, extraArgs })
  return { ok: res.exitCode === 0, stage: 'run', file, reused, attempts, ...res }
}

/**
 * 接单分拆编排：大目标 → 分拆成子任务清单 → 每个子任务生成一条 flow → fanOut 并发执行。
 *
 * **续跑锁定**两段都有：tasks.json 已存在则不重新分拆；每个子任务的 flow.mjs 已存在则不重新生成。
 * 这把 todo-drain 的「拆多组 → 并发跑子 flow」模式做成了通用的、由 LLM 驱动分拆的版本——共用 fanOut 底座。
 *
 * @param {string} goal
 * @param {object} o
 *   - repo / runId / agent / agents / providers
 *   - generate     注入的 flow 生成函数（测试用）
 *   - decomposeGen 注入的分拆生成函数（测试用，省真实 LLM）
 *   - concurrency  fanOut 并发度（默认 2）
 *   - isolate      'worktree' | 'none'（默认 worktree）
 *   - dryRun / timeout / onData
 * @returns {Promise<{ok, stage, runId, tasks, results?, error?, task?}>}
 */
// 并发生成子 flow 时对 LLM API 的并发上限（默认 3）。
// 子任务执行（fanOut）有独立 concurrency 控制；此常量仅限「生成阶段」防 429 轰击。
const DEFAULT_GEN_CONCURRENCY = 3

export async function orchestrateMulti(goal, {
  repo = process.cwd(), runId = `orchm-${Date.now()}`,
  agent, agents = {}, providers = {}, generate, decomposeGen,
  concurrency = 2, genConcurrency = DEFAULT_GEN_CONCURRENCY,
  isolate = 'worktree', dryRun = false, timeout, onData,
} = {}) {
  const dep = checkFlowcastResolvable(repo)
  if (!dep.ok) return { ok: false, stage: 'precheck', runId, error: dep.error }

  const runDir = join(flowcastDir(repo), 'runs', runId)
  mkdirSync(runDir, { recursive: true })

  // ① 分拆（续跑锁定：lockDir + tasks.json 已存在则不重新分拆）
  const tasksLockDir = join(runDir, '.lock-decompose')
  const tasksPath = join(runDir, 'tasks.json')
  let tasks
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const claimed = await acquireLock(tasksLockDir, runId, { allowReuse: true, producePath: tasksPath })
    if (claimed === 'reused') {
      // tasks.json 已存在（被前任完成），直接读
      tasks = JSON.parse(readFileSync(tasksPath, 'utf8'))
      break
    }
    if (claimed === null) {
      // stale 锁已清理 → 重试
      continue
    }
    if (claimed !== true) {
      throw new Error(
        `orchestrateMulti: runId=${runId} 正在被 pid=${claimed.pid} 分拆` +
        `（startedAt=${new Date(claimed.startedAt).toISOString()}）。` +
        `如确认已死，可手动 rm -rf ${tasksLockDir} 后重试。`,
      )
    }
    let d
    try {
      d = await decompose(goal, { repo, agent, agents, providers, generate: decomposeGen })
    } catch (e) {
      releaseLock(tasksLockDir)
      return { ok: false, stage: 'decompose', runId, error: e.message }
    }
    tasks = d.tasks
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8')
    releaseLock(tasksLockDir)
    break
  }

  // ② 每个子任务生成一条 flow（限并发生成+校验；续跑锁定：sub/<name>/flow.mjs 已存在则复用）
  // 原先顺序生成：N 个子任务 × 平均 10s/个 = 50s 才开始执行（execution 阶段已是并发）。
  // 并发生成可降低总耗时，但 Promise.all 无限并发会同时轰击 LLM API 触发 429。
  // 改用 parallel({concurrency: genConcurrency}) 限流：生成时间接近无限并发，同时避免限额。
  // strict=true：任意子任务失败立即向上传播（与旧 Promise.all 行为一致）。
  let flowTasks
  try {
    flowTasks = await parallel(
      tasks.map((t) => async () => {
        const subDir = join(runDir, 'sub', t.name)
        const file = join(subDir, 'flow.mjs')
        if (!existsSync(file)) {
          const g = await generateFlow(t.goal, {
            repo, runDir: subDir, agent: t.agent ?? agent, agents, providers, generate,
          })
          if (!g.validation.ok) {
            const err = new Error(g.validation.error)
            err.taskName = t.name
            err.stage = 'generate'
            throw err
          }
        }
        return { name: t.name, flow: file, runId: `${runId}-${t.name}`, goal: t.goal, agent: t.agent ?? agent }
      }),
      { concurrency: genConcurrency, strict: true },
    )
  } catch (e) {
    // strict=true 时 parallel 把所有失败打包进 e.failures；取第一个的原始错误保持原有返回形状。
    const cause = e.failures?.[0]?.error ?? e
    return { ok: false, stage: 'generate', runId, task: cause.taskName ?? '?', error: cause.message, tasks: tasks.length }
  }

  // ③ fanOut 并发执行（worktree 隔离 + per-task 日志 + 续跑由各子 flow 的 --run-id 负责）
  //    onResult 自动调 archiveChildRun：worktree 隔离下子 run 落 worktree 内 .flowcast/runs/，
  //    归档到主仓 .flowcast/runs/ 让 dashboard 看到子 run 完整数据（父子关系靠 state.parentRunId）。
  const { archiveChildRun } = await import('../subflow.js')
  const results = await fanOut(flowTasks, {
    repo, concurrency, isolate, dryRun, timeout, logDir: runDir, onData,
    onResult: async ({ task, result, worktree }) => {
      if (worktree && task.runId) {
        archiveChildRun(repo, worktree, task.runId)
      }
    },
  })

  return { ok: results.every(r => r.result.ok), stage: 'run', runId, tasks: tasks.length, results }
}

/**
 * 续跑锁：mkdir 锁目录 + owner.json 记录 PID/startedAt/runId。
 * 比旧「O_EXCL 创建 0-byte 文件」方案更可靠：
 *   - 0-byte 是「独占锁刚拿还没写」合法中间态，旧实现会把它当僵尸误删。
 *   - mkdir O_EXCL 是 POSIX 原子操作，并发调用只有一个成功。
 *   - stale 判定看 owner.json 的 PID（信号 0 检测活死）+ createdAt，避免误删活锁。
 *
 * @param {string} lockDir   锁目录路径（通常是 runDir/.lock）
 * @param {string} runId
 * @param {object} [o]
 * @param {boolean} [o.allowReuse]  true 时若产物已就绪（producePath 存在），返回 'reused'
 * @param {string} [o.producePath]  产物路径（与 allowReuse 配合：flow.mjs / tasks.json）
 * @returns {Promise<true | 'reused' | {busy:true, pid, startedAt, runId} | null>}
 *   true = 拿到锁（调用方负责 releaseLock）
 *   'reused' = 产物已存在（仅当 allowReuse=true），无需再生成
 *   {pid, startedAt, runId} = 别的活进程持有锁
 *   null = stale 锁已被本调用清理，下一轮重试
 */
async function acquireLock(lockDir, runId, { allowReuse = false, producePath } = {}) {
  // 0) 续跑命中（最常见）：产物已就绪 + 锁目录已被前任 release 干净。
  //    与「锁目录已存在但产物没就绪」区分——后者说明前任正在跑，按 busy 处理。
  if (allowReuse && producePath && existsSync(producePath) && !existsSync(lockDir)) {
    return 'reused'
  }
  // 第一步：尝试 mkdir O_EXCL 拿锁
  try {
    mkdirSync(lockDir, { recursive: false })
    // 拿到锁，立刻写 owner.json（防 SIGKILL 后锁成无主状态）
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      runId,
    }))
    // 锁拿到了，但产物已存在（前任 SIGKILL 后产物落地但 lockDir 还在）→ 视为续跑
    if (allowReuse && producePath && existsSync(producePath)) {
      // release 锁，让 reused 路径不持锁返回
      releaseLock(lockDir)
      return 'reused'
    }
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  // 锁目录已存在：等 owner.json 写完（最多 LOCK_WAIT_TRIES * LOCK_WAIT_MS）
  for (let i = 0; i < LOCK_WAIT_TRIES; i++) {
    const ownerPath = join(lockDir, 'owner.json')
    if (existsSync(ownerPath)) {
      let owner
      try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')) } catch { owner = null }
      if (owner?.pid) {
        // PID 活着 → 真的忙
        if (isPidAlive(owner.pid)) {
          return { pid: owner.pid, startedAt: owner.startedAt, runId: owner.runId }
        }
        // PID 已死 → 看是否够 stale
        const ageMs = Date.now() - (owner.startedAt ?? 0)
        if (ageMs < STALE_LOCK_MS) {
          // 刚 SIGKILL 没多久，可能是活进程残留锁；为安全抛错不清理
          return { pid: owner.pid, startedAt: owner.startedAt, runId: owner.runId }
        }
        // 僵尸锁：清理后下一轮重试
        rmSync(lockDir, { recursive: true, force: true })
        return null
      }
    }
    await new Promise(r => setTimeout(r, LOCK_WAIT_MS))
  }
  // 等不到 owner.json：尝试 stale 兜底（看 lockDir 自身的 mtime）
  try {
    const stat = statSync(lockDir)
    const ageMs = Date.now() - stat.mtimeMs
    if (ageMs > STALE_LOCK_MS) {
      rmSync(lockDir, { recursive: true, force: true })
      return null
    }
  } catch { /* statSync 失败就当忙处理 */ }
  return { pid: 0, startedAt: 0, runId }
}

/**
 * 释放锁：删 lockDir（含 owner.json）。
 * 失败仅警告不抛——锁最终会被 stale 检测清掉（owner.startedAt 超 STALE_LOCK_MS 后）。
 */
function releaseLock(lockDir) {
  try {
    rmSync(lockDir, { recursive: true, force: true })
  } catch (e) {
    console.warn(`orchestrate: 释放锁失败 ${lockDir}：${e.message}（锁将在 ${STALE_LOCK_MS / 1000}s 后被 stale 检测清理）`)
  }
}

/** 检测 PID 是否还活着（不实际发信号，仅探测）。Linux/macOS 用 process.kill(pid, 0)。 */
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    if (e.code === 'ESRCH') return false  // 进程不存在
    if (e.code === 'EPERM') return true   // 无权发信号，但进程存在，不能清锁
    return false
  }
}
