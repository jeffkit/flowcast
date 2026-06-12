// orchestrator/run.js — 执行生成的 flow（护栏③：子进程隔离 + 续跑锁定）

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateFlow } from './generate.js'
import { decompose } from './decompose.js'
import { runFlow, fanOut } from '../subflow.js'

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
  const runDir = join(repo, '.flowx', 'runs', runId)
  const file = join(runDir, 'flow.mjs')
  let reused = false
  let attempts = 0

  if (existsSync(file)) {
    reused = true // 续跑锁定
  } else {
    const g = await generateFlow(request, { repo, runDir, agent, agents, providers, generate })
    attempts = g.attempts
    if (!g.validation.ok) return { ok: false, stage: 'generate', error: g.validation.error, file, attempts }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'request.txt'), request, 'utf8')
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
export async function orchestrateMulti(goal, {
  repo = process.cwd(), runId = `orchm-${Date.now()}`,
  agent, agents = {}, providers = {}, generate, decomposeGen,
  concurrency = 2, isolate = 'worktree', dryRun = false, timeout, onData,
} = {}) {
  const runDir = join(repo, '.flowx', 'runs', runId)
  mkdirSync(runDir, { recursive: true })

  // ① 分拆（续跑锁定：tasks.json 已存在则复用，绝不重新分拆）
  const tasksPath = join(runDir, 'tasks.json')
  let tasks
  if (existsSync(tasksPath)) {
    tasks = JSON.parse(readFileSync(tasksPath, 'utf8'))
  } else {
    let d
    try {
      d = await decompose(goal, { repo, agent, agents, providers, generate: decomposeGen })
    } catch (e) {
      return { ok: false, stage: 'decompose', runId, error: e.message }
    }
    tasks = d.tasks
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8')
  }

  // ② 每个子任务生成一条 flow（顺序生成+校验；续跑锁定：sub/<name>/flow.mjs 已存在则复用）
  const flowTasks = []
  for (const t of tasks) {
    const subDir = join(runDir, 'sub', t.name)
    const file = join(subDir, 'flow.mjs')
    if (!existsSync(file)) {
      const g = await generateFlow(t.goal, {
        repo, runDir: subDir, agent: t.agent ?? agent, agents, providers, generate,
      })
      if (!g.validation.ok) {
        return { ok: false, stage: 'generate', runId, task: t.name, error: g.validation.error, tasks: tasks.length }
      }
    }
    flowTasks.push({ name: t.name, flow: file, runId: `${runId}-${t.name}`, goal: t.goal, agent: t.agent ?? agent })
  }

  // ③ fanOut 并发执行（worktree 隔离 + per-task 日志 + 续跑由各子 flow 的 --run-id 负责）
  const results = await fanOut(flowTasks, {
    repo, concurrency, isolate, dryRun, timeout, logDir: runDir, onData,
  })

  return { ok: results.every(r => r.result.ok), stage: 'run', runId, tasks: tasks.length, results }
}
