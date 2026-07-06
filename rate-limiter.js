// rate-limiter.js — 自学习的限流感知模块
//
// 设计原则：
//   - LLM 是唯一的解析器，不手写正则规则
//   - LLM 的每次解析结果会沉淀为「特征」写回特征库
//   - 下次同类错误直接跑特征库，命中则跳过 LLM
//   - 特征库随使用自动积累，越用越准
//
// 两个持久化文件：
//   ~/.flowcast/rl-patterns.json  — 特征库（LLM 沉淀的匹配规则）
//   ~/.flowcast/rate-limits.json  — 当前限流状态（cli/model → availableAt）

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawnCapture } from './spawn.js'

// ── 文件路径 ─────────────────────────────────────────────────────────

function flowcastHome() {
  const dir = join(homedir(), '.flowcast')
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
  return dir
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJson(path, data) {
  try { writeFileSync(path, JSON.stringify(data, null, 2), 'utf8') } catch { /* 写失败不影响主流程 */ }
}

// ── 特征库 ───────────────────────────────────────────────────────────
//
// 结构：数组，每条特征由 LLM 生成，格式：
// {
//   id: string,          唯一 ID（cli/model + 时间戳）
//   cli: string,         适用的 CLI 名（null = 通用）
//   model: string,       适用的模型名（null = 通用）
//   match: string,       正则字符串，匹配错误输出
//   windowMs: number,    限流窗口时长（ms）
//   resetType: 'window'|'weekly'|'absolute',
//                        window = 从触发时刻起算 windowMs
//                        weekly = 取 windowMs 与下周一 00:00 较晚
//                        absolute = 从输出里提取绝对时间（依赖 extractRe）
//   extractRe: string,   可选，从匹配文本提取绝对时间的正则（captureGroup 1 = ISO/时间字符串）
//   addedAt: string,     ISO 时间，记录何时加入
//   source: string,      来自哪次 LLM 解析（cli/model/timestamp）
// }

function patternsFile() { return join(flowcastHome(), 'rl-patterns.json') }
function stateFile()    { return join(flowcastHome(), 'rate-limits.json') }

function loadPatterns() { return readJson(patternsFile()) ?? [] }
function savePatterns(patterns) { writeJson(patternsFile(), patterns) }

function loadState() { return readJson(stateFile()) ?? {} }
function saveState(state) { writeJson(stateFile(), state) }

// ── 特征匹配 ─────────────────────────────────────────────────────────

/**
 * 对错误输出跑特征库，返回第一条命中的特征及计算出的 availableAt。
 * @param {string} cli
 * @param {string} model
 * @param {string} output
 * @returns {{ availableAt: number, pattern: object } | null}
 */
export function matchPattern(cli, model, output) {
  if (!output) return null
  const patterns = loadPatterns()
  const now = Date.now()

  for (const p of patterns) {
    // 特征的 cli/model 字段为 null 时匹配所有
    if (p.cli && p.cli !== cli) continue
    if (p.model && p.model !== model) continue
    let re
    try { re = new RegExp(p.match, 'i') } catch { continue }
    if (!re.test(output)) continue

    // 命中：计算可用时间
    let availableAt = now + (p.windowMs ?? 3_600_000)

    if (p.resetType === 'absolute' && p.extractRe) {
      // 从输出提取绝对时间
      try {
        const extract = new RegExp(p.extractRe, 'i')
        const m = output.match(extract)
        if (m?.[1]) {
          const t = Date.parse(m[1])
          if (t > now) availableAt = t
        }
      } catch { /* 提取失败回退 window */ }
    } else if (p.resetType === 'weekly') {
      availableAt = Math.max(availableAt, nextMondayUTC(now))
    }

    return { availableAt, pattern: p }
  }
  return null
}

function nextMondayUTC(from) {
  const d = new Date(from)
  const daysUntil = d.getUTCDay() === 0 ? 1 : (8 - d.getUTCDay()) % 7 || 7
  d.setUTCDate(d.getUTCDate() + daysUntil)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}

// ── LLM 解析 + 特征沉淀 ─────────────────────────────────────────────

const LLM_PROMPT = (cli, model, output) =>
`You are analyzing a CLI error to detect rate limiting and extract reusable detection patterns.

CLI: ${cli}
Model: ${model || 'unknown'}
Error output (first 2000 chars):
---
${output.slice(0, 2000)}
---

Reply ONLY with a JSON object (no markdown fences), this exact shape:

{
  "rateLimited": true,
  "availableAt": "2026-06-28T14:30:00Z",
  "windowMs": 18000000,
  "resetType": "window",
  "pattern": {
    "match": "rate limit|quota exceeded",
    "extractRe": "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z)",
    "note": "GLM 5h window, resets weekly on Monday"
  }
}

Rules:
- rateLimited: true if this is a rate-limit / quota / usage-limit error, false otherwise
- availableAt: ISO 8601 UTC timestamp of when the CLI will be available again; null if unknown
- windowMs: duration in ms until reset (e.g. 5h = 18000000); null if unknown
- resetType: "window" (from now), "weekly" (next Monday 00:00 UTC), "absolute" (availableAt from output)
- pattern.match: a regex string that would match the key phrase(s) in this error output (will be used for future detection without LLM)
- pattern.extractRe: optional regex with capture group 1 that extracts the absolute time string from the output; omit if resetType != "absolute"
- pattern.note: short human-readable note about this rate limit rule

If not rate-limited: {"rateLimited": false}`

/**
 * 用 LLM 解析限流错误，并将结果沉淀为特征写回特征库。
 * @param {string} cli
 * @param {string} model
 * @param {string} output   原始错误输出
 * @param {object} [opts]
 * @param {string} [opts.llmCli]  用哪个 CLI 解析（默认 gemini）
 * @returns {Promise<{rateLimited:boolean, availableAt:number|null}>}
 */
export async function analyzeWithLLM(cli, model, output, { llmCli } = {}) {
  const parserCli = llmCli ?? process.env.FLOWCAST_RATE_LIMIT_LLM_CLI ?? 'gemini'
  const parserModel = parserCli === 'gemini' ? 'gemini-2.0-flash' : null

  // 循环依赖防护：被限流的 CLI 就是解析用的 LLM 时，再调它等于用已限流的 CLI 解析自己，
  // 必然失败且可能引发二次限流。直接返回 false，让上层走 default 1h 冷却兜底。
  if (cli === parserCli) return { rateLimited: false, availableAt: null }

  try {
    const prompt = LLM_PROMPT(cli, model, output)
    const args = parserModel
      ? ['-p', prompt, '--model', parserModel]
      : ['-p', prompt]
    const { stdout, exitCode } = await spawnCapture(parserCli, args, { timeout: 20_000 })
    if (exitCode !== 0) return { rateLimited: false, availableAt: null }

    // 从输出里提取第一个 JSON 对象
    const m = stdout.match(/\{[\s\S]*\}/)
    if (!m) return { rateLimited: false, availableAt: null }
    const parsed = JSON.parse(m[0])

    if (!parsed.rateLimited) return { rateLimited: false, availableAt: null }

    // 计算 availableAt
    const now = Date.now()
    let availableAt = null
    if (parsed.availableAt) {
      const t = Date.parse(parsed.availableAt)
      if (t > now) availableAt = t
    }
    if (!availableAt && parsed.windowMs) {
      availableAt = now + parsed.windowMs
      if (parsed.resetType === 'weekly') availableAt = Math.max(availableAt, nextMondayUTC(now))
    }

    // 沉淀特征到特征库
    if (parsed.pattern?.match) {
      const patterns = loadPatterns()
      // 避免重复：同 cli+model+match 已有则覆盖
      const idx = patterns.findIndex(p => p.cli === cli && p.model === (model || null) && p.match === parsed.pattern.match)
      const entry = {
        id: `${cli}/${model || 'default'}/${Date.now()}`,
        cli: cli || null,
        model: model || null,
        match: parsed.pattern.match,
        windowMs: parsed.windowMs ?? null,
        resetType: parsed.resetType ?? 'window',
        extractRe: parsed.pattern.extractRe ?? null,
        note: parsed.pattern.note ?? '',
        addedAt: new Date().toISOString(),
        source: `llm:${parserCli}`,
      }
      if (idx >= 0) patterns[idx] = entry
      else patterns.push(entry)
      savePatterns(patterns)
    }

    return { rateLimited: true, availableAt }
  } catch {
    return { rateLimited: false, availableAt: null }
  }
}

// ── 核心 API ─────────────────────────────────────────────────────────

/**
 * 分析一次错误，记录限流状态。
 *
 * 流程：
 *   1. 跑特征库 → 命中则直接计算可用时间
 *   2. 未命中且 useLLM=true → 调 LLM 解析（沉淀特征到库）
 *   3. 两者都没拿到时间 → 默认 1h 冷却
 *
 * @param {string} cli
 * @param {string} [model]
 * @param {string} [output]   原始错误输出
 * @param {object} [opts]
 * @param {string} [opts.llmCli]   指定解析用的 LLM CLI
 * @param {boolean} [opts.useLLM=true]  是否允许 LLM 解析（特征库未命中时）；
 *                                       设 false 可节省 API 调用，适合批量/低优先级场景。
 *                                       通过 FLOWCAST_RATE_LIMIT_LLM=1 环境变量从 executor 控制。
 * @returns {Promise<{key:string, availableAt:number, source:'pattern'|'llm'|'default'}>}
 */
export async function recordRateLimit(cli, model, output, { llmCli, useLLM = true } = {}) {
  const key = makeKey(cli, model)
  const now = Date.now()
  let availableAt = null
  let source = 'default'

  // 1. 特征库匹配
  const hit = matchPattern(cli, model, output)
  if (hit) {
    availableAt = hit.availableAt
    source = 'pattern'
  }

  // 2. LLM 解析（特征库未命中时，且调用方已显式启用 LLM）
  if (!availableAt && output && useLLM) {
    const llmResult = await analyzeWithLLM(cli, model, output, { llmCli })
    if (llmResult.rateLimited && llmResult.availableAt) {
      availableAt = llmResult.availableAt
      source = 'llm'
    }
  }

  // 3. 默认兜底
  if (!availableAt) {
    availableAt = now + 3_600_000  // 1h
    source = 'default'
  }

  const state = loadState()
  state[key] = {
    cli,
    model: model || 'default',
    availableAt: new Date(availableAt).toISOString(),
    availableAtMs: availableAt,
    source,
    recordedAt: new Date(now).toISOString(),
  }
  saveState(state)

  return { key, availableAt, source }
}

/**
 * 查询某个 CLI/模型的下次可用时间。
 * @returns {{ availableAt:number, remainingMs:number, source:string } | null}  null = 当前可用
 */
export function getAvailableAt(cli, model) {
  const key = makeKey(cli, model)
  const state = loadState()
  const entry = state[key]
  if (!entry) return null
  const now = Date.now()
  const t = entry.availableAtMs ?? Date.parse(entry.availableAt)
  if (!t || t <= now) {
    delete state[key]
    saveState(state)
    return null
  }
  return { availableAt: t, remainingMs: t - now, source: entry.source ?? 'unknown' }
}

/** 检查 CLI/模型是否当前可用。 */
export function isAvailable(cli, model) {
  return getAvailableAt(cli, model) === null
}

/** 列出所有活跃限流记录，按剩余时间升序。 */
export function listRateLimits() {
  const state = loadState()
  const now = Date.now()
  const result = []
  let dirty = false
  for (const [key, entry] of Object.entries(state)) {
    const t = entry.availableAtMs ?? Date.parse(entry.availableAt)
    if (!t || t <= now) { delete state[key]; dirty = true; continue }
    result.push({ key, cli: entry.cli, model: entry.model, availableAt: entry.availableAt, remainingMs: t - now, source: entry.source ?? 'unknown' })
  }
  if (dirty) saveState(state)
  return result.sort((a, b) => a.remainingMs - b.remainingMs)
}

/** 清除指定 CLI/模型的限流记录。 */
export function clearRateLimit(cli, model) {
  const state = loadState()
  delete state[makeKey(cli, model)]
  saveState(state)
}

/** 列出特征库中的所有特征。 */
export function listPatterns() {
  return loadPatterns()
}

/** 手动删除某条特征（按 id）。 */
export function removePattern(id) {
  const patterns = loadPatterns().filter(p => p.id !== id)
  savePatterns(patterns)
}

/** 构造状态库 key。 */
export function makeKey(cli, model) {
  return `${cli}/${model || 'default'}`
}
