// dashboard/collect.js — L1 采集器：把散落的 run 状态读成一个纯数据模型。
//
// flowx 的「可观测原料」全是文件、零 DB：
//   <repo>/.flowx/runs/<runId>/state.json      状态机快照（status/completed/steps/...）
//   <repo>/.flowx/runs/<runId>/run.log.jsonl    逐步审计日志 + cp.event 结构化事件
//   <repo>/.flowx/runs/<runId>/*.log            fanOut 各子任务的纯文本输出（根因常在这）
//   <repo>/.worktrees/<task>/.flowx/runs/...     worktree 隔离的子 run 落这里
//
// 采集器做三件事，且全部是纯函数 + 可注入 now（便于测试、不烧 API）：
//   1. 跨主仓 + 所有 worktree 扫描，按 runId 去重（取信息更全的那份）
//   2. 重建父→子树（drain-X 是 drain-X-<group> 的父，靠 runId 前缀边界匹配）
//   3. 推断僵尸 run：status=running 但 jsonl/state 最近活动超阈值 → 标 stale
//      （进程被 kill/崩溃时没机会把 status 改 failed，只能这样推断）

import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { flowcastDir } from '../dirs.js'

export const DEFAULT_STALE_MS = 10 * 60 * 1000   // 10 分钟无活动且仍 running → 僵尸
const DEFAULT_LOG_TAIL_LINES = 120               // 每个 .log 只嵌入尾部 N 行
const DEFAULT_LOG_TAIL_BYTES = 12_000            // 且不超过 N 字节（防 HTML 膨胀）
const MAX_RESULT_CHARS = 600                     // 步骤 result 嵌入上限（state.json 里可能很大）

/** 读 jsonl 文件 → 解析每行；坏行跳过。返回 [] 表示文件不存在或全坏。 */
function readJsonl(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 半截行/损坏，跳过 */ }
  }
  return out
}

/** 取文本尾部：最后 maxLines 行，且裁到 maxBytes 以内。 */
function tail(text, maxLines, maxBytes) {
  let lines = text.split('\n')
  if (lines.length > maxLines) lines = lines.slice(-maxLines)
  let out = lines.join('\n')
  if (out.length > maxBytes) out = '…(截断)\n' + out.slice(-maxBytes)
  return out
}

/** 安全取 mtime（毫秒）；取不到返回 0。 */
function mtimeMs(path) {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/** 截断步骤 result，避免把 parse-todos 那种巨型 payload 整个嵌进看板。 */
function summarizeResult(result) {
  if (result == null) return null
  const s = typeof result === 'string' ? result : JSON.stringify(result)
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `…(+${s.length - MAX_RESULT_CHARS})` : s
}

/**
 * run.log.jsonl 事件 schema 字典（中央注册表）。
 *
 * 事件由 cp.event(type, data) 写入 jsonl，dashboard summarizeEvents 按这里读。
 * 新增事件 type 时务必：(1) 在此表登记 schema；(2) 在 summarizeEvents 加 case。
 *
 * schema: { fieldName: 'type' | 'optional type' }
 * writer: 负责写入的源（哪个模块 + 哪行）
 * reader: 负责读的源（通常是 dashboard summarizeEvents）
 */
export const EVENT_TYPES = {
  fallback: {
    schema: { scope: "'provider'|'cli'", cli: 'string', from: 'string', to: 'string', reason: 'string' },
    writer: 'agent.js（emitAgentEvent，触发于 provider/CLI 限额回退）',
    reader: 'dashboard/collect.js summarizeEvents（按 scope 分桶）',
  },
  gate: {
    schema: { name: 'string', status: "'pass'|'fail'", exitCode: 'number' },
    writer: 'quality-gate.js runGates 的 onEvent 回调',
    reader: 'dashboard/collect.js summarizeEvents（gatePass / gateFail 计数）',
  },
  group: {
    schema: { name: 'string', status: "'done'|'failed'", reason: 'optional string' },
    writer: 'subflow.js fanOut onResult（每组完成后写）',
    reader: 'dashboard/collect.js summarizeEvents（按 status 计数）',
  },
  loop: {
    schema: { phase: "'start'|'iterate'|'turn-done'|'budget'|'failed'", turn: 'number', fromTurn: 'optional number', maxTurns: 'optional number', reason: 'optional string', done: 'optional boolean', error: 'optional string' },
    writer: 'loop.js emit()（每个阶段发一条）',
    reader: 'dashboard/collect.js summarizeEvents（统计 turn 数 / 预算触发 / 失败）',
  },
}

/**
 * 把 jsonl 事件流归并成可观测信号（fallback 率 / 质量门红灯 / fanOut 分组 / 修复轮数 / loop 周期）。
 * 事件由 cp.event 写入：{event: EVENT_TYPES key, ...}。
 */
function summarizeEvents(events, steps) {
  const signals = {
    fallback: 0,            // provider/CLI 回退次数（429 等）
    fallbackByScope: {},    // {provider:n, cli:n}（按回退类型分类，供看板钻取）
    gatePass: 0,
    gateFail: 0,
    group: { done: 0, failed: 0 },
    fixRounds: 0,           // fix-loop 轮数（从 step key 推断）
    loop: {                 // loop 周期统计
      turns: 0,             // 总 turn 数
      done: 0,              // 达到 isDone 的次数
      budgetExhausted: 0,   // budget 触顶的次数
      failed: 0,            // iterate 抛错的次数
    },
  }
  for (const e of events) {
    if (e.event === 'fallback') {
      signals.fallback++
      // scope: 'provider'（同 CLI 换 provider）或 'cli'（跨 CLI 回退）
      signals.fallbackByScope[e.scope ?? 'unknown'] = (signals.fallbackByScope[e.scope ?? 'unknown'] ?? 0) + 1
    } else if (e.event === 'gate') {
      if (e.status === 'pass') signals.gatePass++
      else if (e.status === 'fail') signals.gateFail++
    } else if (e.event === 'group') {
      if (e.status === 'failed') signals.group.failed++
      else signals.group.done++
    } else if (e.event === 'loop') {
      // loop 阶段：start / iterate / turn-done / budget / failed
      if (e.phase === 'turn-done') signals.loop.turns++
      else if (e.phase === 'budget') signals.loop.budgetExhausted++
      else if (e.phase === 'failed') signals.loop.failed++
      // 兼容 done 字段（end-of-loop marker）
      if (e.done === true) signals.loop.done++
    }
  }
  // fix-loop 轮数：force-dev 的修复步形如 p3.<m>.fix-1 / fix-2…
  signals.fixRounds = steps.filter(s => /\.fix-\d+$/.test(s.key)).length
  return signals
}

/**
 * 读单个 run 目录 → run 对象；目录里没有 state.json 返回 null（非 run 目录）。
 * @param {string} dir     run 目录绝对路径
 * @param {string} runId
 * @param {object} o       { now, staleMs, logTailLines, logTailBytes }
 */
export function readRun(dir, runId, {
  now = Date.now(), staleMs = DEFAULT_STALE_MS,
  logTailLines = DEFAULT_LOG_TAIL_LINES, logTailBytes = DEFAULT_LOG_TAIL_BYTES,
} = {}) {
  const statePath = join(dir, 'state.json')
  if (!existsSync(statePath) && !existsSync(statePath + '.bak')) return null
  // 先尝试 state.json，损坏时回退 .bak（镜像 Checkpoint._loadState 的恢复逻辑）
  let state
  for (const src of [statePath, statePath + '.bak']) {
    if (!existsSync(src)) continue
    try { state = JSON.parse(readFileSync(src, 'utf8')); break } catch { /* try .bak */ }
  }
  if (!state) return null

  const logPath = join(dir, 'run.log.jsonl')
  const logEntries = readJsonl(logPath)
  // 区分「步骤日志」（有 key）与「结构化事件」（有 event）
  const events = logEntries.filter(e => e.event != null)

  const lastActivityMs = Math.max(mtimeMs(statePath), mtimeMs(logPath))
  const status = state.status ?? 'unknown'
  // 自适应僵尸阈值：state.expectMaxMs 字段声明当前 run 期望最长跑多久（loop.js 自动算 maxTurns*stepAvg）。
  // 有声明 → 用 max(staleMs, expectMaxMs)；没声明 → 用 staleMs 兜底（默认 10min）。
  const expectMaxMs = Number.isFinite(state.expectMaxMs) ? state.expectMaxMs : 0
  const effectiveStaleMs = Math.max(staleMs, expectMaxMs)
  // stale 判定：(a) 正常路径——state 文件存在 + mtime 早于阈值；(b) 异常路径——
  // state.json 存在但 mtimeMs=0（stat 失败：权限/磁盘/被删后立刻重建），
  // 此时 lastActivityMs 兜底取文件自身 mtime（应已能拿到）。如果连 mtime 都拿不到，
  // 说明文件系统异常，保守判 stale（避免误把死进程当活）。
  const stateMtimeOk = mtimeMs(statePath) > 0
  const stale = status === 'running' && stateMtimeOk && (now - lastActivityMs) > effectiveStaleMs
  // 显式标注：state 文件 mtime 拿不到 → 「orphaned」状态（区别于"超过阈值才 stale"）
  const orphanedStateFile = status === 'running' && !stateMtimeOk

  // 从 jsonl 建 start 时间戳索引（onStep 钩子写入），用于计算步骤等待时间。
  const startTsMap = new Map()
  const skipKeys = new Set()
  for (const e of logEntries) {
    if (e.key && e.status === 'start' && e.ts) startTsMap.set(e.key, e.ts)
    if (e.key && e.status === 'skip') skipKeys.add(e.key)
  }

  const steps = (state.steps ?? []).map(s => ({
    key: s.key,
    status: s.status ?? 'done',
    durationMs: Number.isFinite(s.durationMs) ? s.durationMs : null,
    startedAt: startTsMap.get(s.key) ?? null,
    completedAt: s.completedAt ?? null,
    cli: s.cli ?? null,
    model: s.model ?? null,
    inputTokens: Number.isFinite(s.inputTokens) ? s.inputTokens : null,
    outputTokens: Number.isFinite(s.outputTokens) ? s.outputTokens : null,
  }))

  // 按 run 汇总 token 与用到的模型（仅 claude/cursor adapter 透出 token；其余为 null）。
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, hasTokens: false }
  const modelSet = new Set()
  for (const s of steps) {
    if (s.model) modelSet.add(`${s.cli ?? '?'}:${s.model}`)
    else if (s.cli) modelSet.add(s.cli)
    if (s.inputTokens != null || s.outputTokens != null) {
      usage.inputTokens += s.inputTokens ?? 0
      usage.outputTokens += s.outputTokens ?? 0
      usage.hasTokens = true
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens
  const models = [...modelSet]

  // 计算步间 gap（上步 completedAt → 本步 startedAt），需要 onStep 钩子写入的 start 时间戳。
  for (let i = 0; i < steps.length; i++) {
    const prev = steps[i - 1]
    const cur = steps[i]
    if (prev?.completedAt && cur.startedAt) {
      const gap = new Date(cur.startedAt) - new Date(prev.completedAt)
      cur.waitMs = Number.isFinite(gap) && gap >= 0 ? gap : null
    } else {
      cur.waitMs = null
    }
  }

  // 跳过步（续跑时已完成的步骤）从 jsonl skip 条目重建，附上 completedAt（来自 state.completed 写入时间）。
  const skippedSteps = [...skipKeys].map(key => ({ key, status: 'skip' }))

  // 找出失败步：jsonl 里 status=error 的步骤 key（步骤本身在 state.steps 里只存成功的）
  const errorSteps = logEntries
    .filter(e => e.key != null && e.status === 'error')
    .map(e => ({ key: e.key, error: e.error ?? null, durationMs: e.durationMs ?? null }))

  // fanOut 父目录里的 per-task 纯文本日志（<task>.log）——失败根因常在这
  const logs = []
  for (const f of safeReaddir(dir)) {
    if (!f.endsWith('.log')) continue   // run.log.jsonl 以 .jsonl 结尾，天然排除
    const p = join(dir, f)
    try {
      logs.push({ name: f, tail: tail(readFileSync(p, 'utf8'), logTailLines, logTailBytes), mtimeMs: mtimeMs(p) })
    } catch { /* 读不动就跳过 */ }
  }

  const startedAt = state.startedAt ?? null
  const completedAt = state.completedAt ?? null
  const durationMs = startedAt && completedAt
    ? (new Date(completedAt) - new Date(startedAt))
    : (startedAt ? (lastActivityMs ? lastActivityMs - new Date(startedAt) : null) : null)

  return {
    runId,
    dir,
    state,  // 完整 state.json（dashboard render 用 + 父子关系 parentRunId 字段）
    status,
    stale,
    orphanedStateFile,  // state 文件 mtime 拿不到（stat 失败）→ 异常态
    displayStatus: stale ? 'stale' : (orphanedStateFile ? 'stale' : status),
    feature: state.pauseContext?.feature ?? state.summary?.feature ?? null,
    startedAt,
    completedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    currentStep: state.currentStep ?? null,
    pauseReason: state.pauseReason ?? null,
    summary: state.summary ?? null,
    completedCount: Object.keys(state.completed ?? {}).length,
    stepCount: steps.length,
    skippedCount: skippedSteps.length,
    errorSteps,
    skippedSteps,
    paused: status === 'paused',
    usage,
    models,
    steps,
    events: events.map(e => ({ ...e, result: e.result !== undefined ? summarizeResult(e.result) : undefined })),
    signals: summarizeEvents(events, steps),
    lastActivityMs,
    lastActivity: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    logs,
  }
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** 在所有 runId 中找 r 的父：最长的、是 r 严格前缀且以 '-' 为边界的那个。 */
function findParent(runId, allIds) {
  let best = null
  for (const id of allIds) {
    if (id === runId) continue
    if (runId.startsWith(id + '-') && (!best || id.length > best.length)) best = id
  }
  return best
}

/**
 * 采集一个仓（含其所有 worktree）的全部 run。
 *
 * @param {string} repo  仓根目录
 * @param {object} [o]
 *   - now          注入「当前时间」（毫秒），便于测试僵尸判定
 *   - staleMs      僵尸阈值（默认 10min）
 *   - includeWorktrees  是否扫 .worktrees（默认 true）
 * @returns {{repo, generatedAt, staleMs, runs:Run[], roots:string[], stats}}
 */
export function collectRuns(repo, {
  now = Date.now(), staleMs = DEFAULT_STALE_MS, includeWorktrees = true,
  logTailLines, logTailBytes,
} = {}) {
  const opts = { now, staleMs, logTailLines, logTailBytes }
  const byId = new Map()   // runId → run（去重时保留信息更全的）

  // run id 只允许不含路径分隔符且不以 . 开头的名称，防止 .. 穿越到父目录
  const VALID_RUN_ID = /^[^./\\][^/\\]*$/
  const scanRunsRoot = (runsRoot) => {
    for (const id of safeReaddir(runsRoot)) {
      if (!VALID_RUN_ID.test(id)) continue
      const dir = join(runsRoot, id)
      let isDir = false
      try { isDir = statSync(dir).isDirectory() } catch { /* skip */ }
      if (!isDir) continue
      const run = readRun(dir, id, opts)
      if (!run) continue
      const prev = byId.get(id)
      // 同名取「完成步骤更多」的那份（worktree 内子 run 通常比主仓占位更全）
      if (!prev || run.completedCount > prev.completedCount || run.stepCount > prev.stepCount) {
        byId.set(id, run)
      }
    }
  }

  scanRunsRoot(join(flowcastDir(repo), 'runs'))
  if (includeWorktrees) {
    const wtRoot = join(repo, '.worktrees')
    for (const wt of safeReaddir(wtRoot)) {
      scanRunsRoot(join(flowcastDir(join(wtRoot, wt)), 'runs'))
    }
  }

  const runs = [...byId.values()]
  const allIds = runs.map(r => r.runId)
  // 父子关系：优先用 state.parentRunId 显式字段（subflow/orchestrator 写入），
  // 没有该字段时 fallback 到 prefix 启发式（向后兼容旧 run）。两种来源在 r.parentIdSource 标记。
  for (const r of runs) {
    const explicit = r.state?.parentRunId
    if (explicit && allIds.includes(explicit) && explicit !== r.runId) {
      r.parentId = explicit
      r.parentIdSource = 'explicit'
    } else {
      r.parentId = findParent(r.runId, allIds)
      r.parentIdSource = r.parentId ? 'heuristic' : null
    }
  }
  const childrenOf = new Map()
  for (const r of runs) {
    if (!r.parentId) continue
    if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, [])
    childrenOf.get(r.parentId).push(r.runId)
  }
  for (const r of runs) r.children = childrenOf.get(r.runId) ?? []

  // 父 run 汇总子 run 的 token（drain 父自身不跑 agent，token 在各子 run 里）。
  const byIdMap = byId
  for (const r of runs) {
    if (!r.children.length) { r.childUsage = null; continue }
    const cu = { inputTokens: 0, outputTokens: 0, totalTokens: 0, hasTokens: false }
    for (const cid of r.children) {
      const c = byIdMap.get(cid)
      if (!c?.usage?.hasTokens) continue
      cu.inputTokens += c.usage.inputTokens
      cu.outputTokens += c.usage.outputTokens
      cu.hasTokens = true
    }
    cu.totalTokens = cu.inputTokens + cu.outputTokens
    r.childUsage = cu.hasTokens ? cu : null
  }

  // 默认排序：最近活动倒序（最新的在前）
  runs.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0))

  const roots = runs.filter(r => !r.parentId).map(r => r.runId)
  const stats = computeStats(runs)

  return { repo, generatedAt: new Date(now).toISOString(), staleMs, runs, roots, stats }
}

function computeStats(runs) {
  const stats = {
    total: runs.length,
    running: 0, paused: 0, completed: 0, stale: 0, other: 0,
    fallback: 0, gateFail: 0, gatePass: 0,
    skipped: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
  }
  for (const r of runs) {
    if (r.stale) stats.stale++
    else if (r.status === 'running') stats.running++
    else if (r.status === 'paused') stats.paused++
    else if (r.status === 'completed') stats.completed++
    else stats.other++
    stats.fallback += r.signals.fallback
    stats.gateFail += r.signals.gateFail
    stats.gatePass += r.signals.gatePass
    stats.skipped += r.skippedCount ?? 0
    if (r.usage?.hasTokens) {
      stats.inputTokens += r.usage.inputTokens
      stats.outputTokens += r.usage.outputTokens
    }
  }
  stats.totalTokens = stats.inputTokens + stats.outputTokens
  return stats
}
