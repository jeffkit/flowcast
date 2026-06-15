import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { flowcastDir } from './dirs.js'

const DEFAULT_MAX_ENTRIES = 500  // scope 文件超出此条数时，保留最新的一半（LRU 淘汰）

// 进程内行计数缓存：key = scopePath，value = 行数。
// 避免每次 recordLearning 都全量读文件计数——append 后只需 +1，
// 仅在超限时才做一次全量读 + 重写。进程重启时从文件行数重新初始化。
const _lineCountCache = new Map()

// ── memory：轻量「跨-run」记忆（learnings 的持久累积）─────────────────
//
// failure-context.js 是热路径：单轮失败「写入即消费」，只注入一次。
// memory.js 是冷路径：把经验/教训跨多次 run 持久沉淀，供 loop 每轮（fresh
// context）回读，对应 Ralph Loop 的 progress.md / revengers 的 buildLearningSection。
//
// 刻意保持文件型、零依赖（append-only jsonl + 关键词/tag 召回），不引向量库、
// 不引 SQLite——既守住 flowcast「零运行时依赖」，又把 RAG 接口留口子日后可换。
//
// 存储：<baseDir>/<scope>.jsonl，每行一条 {ts, topic, rootCause, fix, tags, runId}。
// scope 用来隔离不同目标/项目的记忆（如 'force-dev' / 'self-improve'）。

const defaultBase = () => flowcastDir(process.cwd()) + '/memory'

function scopePath(baseDir, scope) {
  const safe = String(scope).replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(baseDir, `${safe}.jsonl`)
}

function readEntries(baseDir, scope) {
  const p = scopePath(baseDir, scope)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && typeof e === 'object')
}

// 关键词/tag 召回打分：query 命中 topic/rootCause/fix（含）加分，tag 命中各加分。
// 无 query 时按时间倒序（最近优先）。刻意简单——接口稳定，日后可替换为向量召回。
function scoreEntry(entry, terms) {
  if (terms.length === 0) return 0
  const hay = `${entry.topic ?? ''} ${entry.rootCause ?? ''} ${entry.fix ?? ''}`.toLowerCase()
  const tags = (entry.tags ?? []).map((t) => String(t).toLowerCase())
  let score = 0
  for (const t of terms) {
    if (hay.includes(t)) score += 1
    if (tags.includes(t)) score += 2
  }
  return score
}

/**
 * 记录一条跨-run 经验（append-only，幂等性由调用方把控）。
 * @param {string} scope    记忆作用域（隔离不同目标/项目）
 * @param {object} entry
 *   - topic      主题（必填，简短）
 *   - rootCause  根因
 *   - fix        修复/结论
 *   - tags       string[] 标签（召回用）
 *   - runId      关联的 run
 * @param {object} [opts] - baseDir 覆盖默认 .flowcast/memory
 * @returns {object} 实际写入的记录（含 ts）
 */
export function recordLearning(scope, entry = {}, { baseDir = defaultBase(), maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const rec = {
    ts: new Date().toISOString(),
    topic: entry.topic ?? 'untitled',
    rootCause: entry.rootCause ?? null,
    fix: entry.fix ?? null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    runId: entry.runId ?? null,
  }
  mkdirSync(baseDir, { recursive: true })
  const p = scopePath(baseDir, scope)
  appendFileSync(p, JSON.stringify(rec) + '\n')

  // 容量守卫：用进程内计数器避免每次写都全量读文件。
  // 首次写该 scope 时从文件行数初始化计数（O(size) 但只做一次），
  // 后续每次 append +1，仅超限时才全量读 + 重写（LRU 淘汰）。
  let lineCount = _lineCountCache.get(p)
  if (lineCount === undefined) {
    // 初始化：统计当前文件行数（已包含刚 append 的那行）
    try {
      lineCount = readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).length
    } catch { lineCount = 1 }
  } else {
    lineCount += 1
  }
  _lineCountCache.set(p, lineCount)

  if (lineCount > maxEntries) {
    const raw = readFileSync(p, 'utf8')
    const entries = raw.split('\n').filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    // 保留最新的 ceil(maxEntries/2) 条，下次再触发前还有半箱余量
    const kept = entries.slice(-Math.ceil(maxEntries / 2))
    writeFileSync(p, kept.map(e => JSON.stringify(e)).join('\n') + '\n')
    _lineCountCache.set(p, kept.length)
  }
  return rec
}

/**
 * 召回 top-K 相关经验。query 命中 topic/rootCause/fix/tags 打分排序；
 * 无 query 时返回最近 K 条。
 * @returns {object[]} 排序后的记录（最多 topK 条）
 */
export function recall(scope, { query = '', topK = 5, baseDir = defaultBase() } = {}) {
  const entries = readEntries(baseDir, scope)
  if (entries.length === 0) return []
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)

  if (terms.length === 0) {
    // 无 query：最近优先
    return entries.slice(-topK).reverse()
  }

  return entries
    .map((e, i) => ({ e, i, score: scoreEntry(e, terms) }))
    .filter((x) => x.score > 0)
    // 分数高优先；同分时较新（i 大）优先，保证稳定且偏向新经验
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, topK)
    .map((x) => x.e)
}

/**
 * 产出可注入 prompt 的 markdown 块（对应 Ralph progress.md / revengers buildLearningSection）。
 * 无相关记忆时返回空串（调用方按需拼接，不污染 prompt）。
 */
export function buildMemorySection(scope, { query = '', topK = 5, baseDir = defaultBase() } = {}) {
  const hits = recall(scope, { query, topK, baseDir })
  if (hits.length === 0) return ''
  const lines = hits.map((h) => {
    const parts = [`- **${h.topic}**`]
    if (h.rootCause) parts.push(`  - 根因: ${h.rootCause}`)
    if (h.fix) parts.push(`  - 结论/修复: ${h.fix}`)
    return parts.join('\n')
  })
  return ['## Learnings from previous runs', '', ...lines, ''].join('\n')
}

/**
 * 把 failure-context（单轮写入即消费）promote 成跨-run 记忆。
 * loop 每轮可用它把热路径的失败上下文沉淀进冷路径。
 * @param {string} scope
 * @param {string|null} failureContent - readAndConsumeFailureContext 的返回
 * @param {object} [meta] - { topic, tags, runId }
 * @returns {object|null} 写入的记录，content 为空则不写、返回 null
 */
export function promoteFailureContext(scope, failureContent, meta = {}, { baseDir = defaultBase() } = {}) {
  if (!failureContent) return null
  return recordLearning(scope, {
    topic: meta.topic ?? 'previous attempt failed',
    rootCause: failureContent.slice(0, 2000),
    fix: meta.fix ?? null,
    tags: meta.tags ?? ['failure'],
    runId: meta.runId ?? null,
  }, { baseDir })
}
