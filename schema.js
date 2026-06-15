// schema.js — 轻量 JSON Schema 校验 + agent 结构化输出包装（零依赖）
//
// 只支持 FLOW_API few-shot 实际用到的子集：type(object/array/string/number/integer/boolean/null)、
// properties、required、items、enum、additionalProperties:false。够覆盖「让 agent 返回结构化数据」
// 这一场景，不追求完整 JSON Schema 规范——保持零运行时依赖 + 可读。

import { isDryRun } from './dry-run.js'

/** 从 LLM 文本里抽出 JSON：优先 ```json fenced，其次第一个平衡 {..}/[..] 块，最后整段 parse。 */
export function extractJson(text) {
  const s = String(text)
  const candidates = []
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (fence) candidates.push(fence[1].trim())
  const balanced = firstBalanced(s)
  if (balanced) candidates.push(balanced)
  candidates.push(s.trim())
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* 试下一个候选 */ }
  }
  return undefined
}

// 扫出第一个完整的 JSON 对象/数组（括号配平，跳过字符串内的括号）。
function firstBalanced(s) {
  const start = s.search(/[{[]/)
  if (start < 0) return null
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return null
}

/**
 * 校验 value 是否符合 schema（支持上述子集）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateSchema(value, schema, path = '$') {
  const errors = []
  walk(value, schema, path, errors)
  return { ok: errors.length === 0, errors }
}

function walk(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return
  const t = schema.type
  if (t && !typeMatches(value, t)) {
    errors.push(`${path}: 期望类型 ${t}，实际 ${jsType(value)}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在 enum [${schema.enum.join(', ')}]`)
  }
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value)
  if ((t === 'object' || (!t && isObj)) && isObj) {
    const props = schema.properties || {}
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${path}: 缺少必填字段 "${req}"`)
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${path}.${k}: 不允许的额外字段`)
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) walk(value[k], sub, `${path}.${k}`, errors)
    }
  }
  if ((t === 'array' || (!t && Array.isArray(value))) && Array.isArray(value) && schema.items) {
    value.forEach((el, i) => walk(el, schema.items, `${path}[${i}]`, errors))
  }
}

function jsType(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

function typeMatches(v, t) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    case 'array': return Array.isArray(v)
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number'
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'boolean': return typeof v === 'boolean'
    case 'null': return v === null
    default: return true
  }
}

/** 按 schema 造一个最小占位值（dry-run 用，让结构化 flow 能空跑、下游解构不炸）。 */
export function stubFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (schema.enum) return schema.enum[0]
  switch (schema.type) {
    case 'object': {
      const o = {}
      const props = schema.properties || {}
      const keys = (schema.required && schema.required.length) ? schema.required : Object.keys(props)
      for (const k of keys) if (props[k]) o[k] = stubFromSchema(props[k])
      return o
    }
    case 'array': return []
    case 'string': return ''
    case 'number': case 'integer': return 0
    case 'boolean': return false
    case 'null': return null
    default: return null
  }
}

/**
 * 用 schema 强制 runner 返回校验过的结构化数据：增强 prompt → 调 runner → 抽 JSON → 校验，
 * 不匹配把错误回喂重试。dry-run 下直接返回 stubFromSchema（不调真 runner）。
 *
 * @param {Function} runner  (prompt) => Promise<string>  实际跑 agent 的函数
 * @param {string} prompt
 * @param {object} [o]
 *   - schema    JSON Schema（子集）；缺省时退化为直接 runner(prompt)
 *   - retries   不匹配重试次数（默认 1，即最多跑 2 次）
 * @returns {Promise<any>} 解析并校验后的值
 */
export async function runStructured(runner, prompt, { schema, retries = 1 } = {}) {
  if (!schema) return runner(prompt)
  if (isDryRun()) return stubFromSchema(schema)
  let priorError
  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await runner(buildSchemaPrompt(prompt, schema, priorError))
    const parsed = extractJson(text)
    if (parsed === undefined) {
      priorError = '输出不是合法 JSON，请只输出一个 JSON（可包在 ```json 代码块里），不要任何解释文字。'
      continue
    }
    const { ok, errors } = validateSchema(parsed, schema)
    if (ok) return parsed
    priorError = `JSON 不符合 schema：\n${errors.join('\n')}`
  }
  const err = new Error(`runStructured: ${retries + 1} 次尝试后仍不符合 schema — ${priorError}`)
  err.schemaError = priorError
  throw err
}

function buildSchemaPrompt(prompt, schema, priorError) {
  let p = `${prompt}\n\n# 输出要求\n只输出一个 JSON，必须符合下面的 JSON Schema（不要任何解释文字）：\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``
  if (priorError) p += `\n\n# 上次输出未通过校验\n${priorError}\n请修正后重新只输出 JSON。`
  return p
}
