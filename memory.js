import { mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { flowcastDir } from './dirs.js'
import { ConfigError } from './errors.js'

const DEFAULT_MAX_ENTRIES = 500  // scope 文件超出此条数时，保留最新的一半（LRU 淘汰）

// 进程内缓存 Map 条数上限（按 scopePath 计）。
// 长生命周期进程（如 daemon）操作大量不同 scope 时，缓存可能无界增长。
// 超限时按插入顺序淘汰最老的条目（Map 的迭代顺序即插入顺序，天然 FIFO LRU）。
const CACHE_MAX_SCOPES = 200

// 进程内行计数缓存：key = scopePath，value = 行数。
// 避免每次 recordLearning 都全量读文件计数——append 后只需 +1，
// 仅在超限时才做一次全量读 + 重写。进程重启时从文件行数重新初始化。
const _lineCountCache = new Map()

// 进程内 entries 缓存：key = scopePath，value = object[]。
// recall / buildMemorySection 每次调用都会全量读文件，对高频 loop 有累积 IO 开销。
// recordLearning 在写入后同步更新此缓存，recall 优先命中缓存（O(1) 读内存），
// 进程重启后首次 recall 触发惰性加载（此时缓存为空）。
const _entriesCache = new Map()

/** 通用 LRU 淘汰：Map 超过 maxSize 时删除最早插入的条目。 */
function evictMapIfNeeded(map, maxSize) {
  if (map.size > maxSize) {
    const oldestKey = map.keys().next().value
    map.delete(oldestKey)
  }
}

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
  const s = String(scope)
  const safe = s.replace(/[^a-zA-Z0-9._-]/g, '_')
  // 若 scope 含特殊字符（被替换成 _），追加 hash 后缀防碰撞（如 'a/b' 与 'a_b' 均映射到 'a_b'）。
  // 纯合法字符的 scope 保持原文件名（向后兼容已有 .jsonl 文件）。
  if (safe === s) return join(baseDir, `${safe}.jsonl`)
  const hash = s.split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)
  return join(baseDir, `${safe}_${(hash >>> 0).toString(36)}.jsonl`)
}

function parseJsonlFile(p) {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && typeof e === 'object')
}

function readEntries(baseDir, scope) {
  const p = scopePath(baseDir, scope)
  // 优先命中进程内缓存，避免每次 recall 都全量读文件（对高频 loop 有明显 IO 收益）。
  // 缓存在 recordLearning 写入时同步更新；进程重启后首次 recall 触发惰性加载。
  if (_entriesCache.has(p)) return _entriesCache.get(p)
  const entries = parseJsonlFile(p)
  _entriesCache.set(p, entries)
  evictMapIfNeeded(_entriesCache, CACHE_MAX_SCOPES)
  return entries
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
  if (!scope) throw new ConfigError('scope must be a non-empty string')
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

  // 进程内 entries 缓存同步更新（与 readEntries 的缓存保持一致）。
  // 若缓存已存在则直接 push，否则重建（首次写、或其他进程写入后缓存失效的兜底）。
  if (_entriesCache.has(p)) {
    _entriesCache.get(p).push(rec)
  } else {
    // 缓存为空时从文件重建（包含刚 append 的新记录）
    _entriesCache.set(p, parseJsonlFile(p))
    evictMapIfNeeded(_entriesCache, CACHE_MAX_SCOPES)
  }

  // 容量守卫：用进程内计数器避免每次写都全量读文件。
  // 首次写该 scope 时从文件行数初始化计数（O(size) 但只做一次），
  // 后续每次 append +1，仅超限时才全量读 + 重写（LRU 淘汰）。
  let lineCount = _lineCountCache.get(p)
  if (lineCount === undefined) {
    lineCount = (_entriesCache.get(p) ?? []).length
  } else {
    lineCount += 1
  }
  _lineCountCache.set(p, lineCount)
  evictMapIfNeeded(_lineCountCache, CACHE_MAX_SCOPES)

  if (lineCount > maxEntries) {
    const allEntries = _entriesCache.get(p) ?? parseJsonlFile(p)
    // 保留最新的 ceil(maxEntries/2) 条，下次再触发前还有半箱余量。
    // 用 write-rename 原子写（先写 .tmp，再 rename 替换）：
    //   - 防止 SIGKILL 截断产生损坏文件
    //   - 两个并发进程同时裁剪时，最后一次 rename 原子覆盖（不会产生半截文件）
    //   - 仍是 best-effort：并发写时后写的进程可能覆盖先写的（不会丢 append 的新记录，
    //     但两次裁剪各自基于快照，最终保留的条数可能多于或少于预期）
    const kept = allEntries.slice(-Math.ceil(maxEntries / 2))
    const tmp = p + '.tmp.' + process.pid
    try {
      writeFileSync(tmp, kept.map(e => JSON.stringify(e)).join('\n') + '\n')
      renameSync(tmp, p)
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清理 tmp 失败忽略 */ }
      console.warn(`[memory] LRU 裁剪写入失败（忽略，下次重试）：${e.message}`)
      return rec  // 不更新缓存计数，让下次 append 再触发
    }
    _lineCountCache.set(p, kept.length)
    _entriesCache.set(p, kept)  // 缓存同步更新为裁剪后的列表
  }
  return rec
}

/**
 * 召回 top-K 相关经验。query 命中 topic/rootCause/fix/tags 打分排序；
 * 无 query 时返回最近 K 条。
 * @returns {object[]} 排序后的记录（最多 topK 条）
 */
export function recall(scope, { query = '', topK = 5, baseDir = defaultBase() } = {}) {
  if (!scope) throw new ConfigError('scope must be a non-empty string')
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
