// schema.js — 轻量 JSON Schema 校验 + agent 结构化输出包装（零依赖）
//
// 支持以下子集：type(object/array/string/number/integer/boolean/null)、
// properties、required、items、enum、additionalProperties:false、
// minimum、maximum、minLength、maxLength、minItems、maxItems。
// 够覆盖「让 agent 返回结构化数据」场景，不追求完整 JSON Schema 规范——保持零运行时依赖 + 可读。

import { isDryRun } from './dry-run.js'
import { SchemaError } from './errors.js'

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
 * @param {any}    value
 * @param {object} schema
 * @param {string} [path='$']
 * @param {object} [opts]
 * @param {boolean} [opts.allowPartialSchema=false]
 *   true = 遇到 oneOf/anyOf/allOf 时只打 warn 并跳过（向后兼容降级），
 *   false = 遇到不支持的关键字时记录错误（P1-A4 修复，默认行为）。
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateSchema(value, schema, path = '$', opts = {}) {
  const errors = []
  walk(value, schema, path, errors, opts)
  return { ok: errors.length === 0, errors }
}

function walk(value, schema, path, errors, opts = {}) {
  if (!schema || typeof schema !== 'object') return
    // 本实现支持以下 JSON Schema 子集：
  //   type / properties / required / items / enum / additionalProperties /
  //   minimum / maximum / minLength / maxLength / minItems / maxItems
  // oneOf/anyOf/allOf 是 P1-A4 修复点：旧实现静默忽略，可能导致校验「假通过」。
  // 新行为：
  //   - schema 未标记 allowPartialSchema=true → 抛错，让调用方知道 schema 超出了本实现的支持范围
  //   - schema 标记 allowPartialSchema=true → warn（向后兼容降级），跳过不支持的关键字
  if (schema.oneOf || schema.anyOf || schema.allOf) {
    const unsupported = ['oneOf', 'anyOf', 'allOf'].filter(k => schema[k]).join(', ')
    if (schema.allowPartialSchema || opts.allowPartialSchema) {
      console.warn(`[schema] 警告：${path} 使用了不支持的关键字（${unsupported}），将被忽略。` +
        `本实现只支持 type/properties/required/items/enum/additionalProperties`)
    } else {
      errors.push(
        `${path}: 使用了不支持的 JSON Schema 关键字（${unsupported}）。` +
        `本实现仅支持子集：type/properties/required/items/enum/additionalProperties。` +
        `若确认可以接受忽略此关键字，请在 schema 顶层加 "allowPartialSchema": true。`,
      )
      return  // 提前退出，避免产生误导性的后续错误
    }
  }
  const t = schema.type
  if (t && !typeMatches(value, t)) {
    errors.push(`${path}: 期望类型 ${t}，实际 ${jsType(value)}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在 enum [${schema.enum.join(', ')}]`)
  }
  // 数值范围约束
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: 值 ${value} 小于 minimum ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: 值 ${value} 大于 maximum ${schema.maximum}`)
    }
  }
  // 字符串长度约束
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: 字符串长度 ${value.length} 小于 minLength ${schema.minLength}`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: 字符串长度 ${value.length} 大于 maxLength ${schema.maxLength}`)
    }
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
      if (k in value) walk(value[k], sub, `${path}.${k}`, errors, opts)
    }
  }
  if ((t === 'array' || (!t && Array.isArray(value))) && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: 数组长度 ${value.length} 小于 minItems ${schema.minItems}`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: 数组长度 ${value.length} 大于 maxItems ${schema.maxItems}`)
    }
    if (schema.items) {
      value.forEach((el, i) => walk(el, schema.items, `${path}[${i}]`, errors, opts))
    }
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
    case 'array': {
      const len = schema.minItems ?? 0
      if (len === 0) return []
      return Array.from({ length: len }, () => schema.items ? stubFromSchema(schema.items) : null)
    }
    case 'string': {
      const min = schema.minLength ?? 0
      return min > 0 ? 'a'.repeat(min) : ''
    }
    case 'number': return schema.minimum != null ? schema.minimum : 0
    case 'integer': return schema.minimum != null ? Math.ceil(schema.minimum) : 0
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
 *   - onFail    'throw'（默认，向后兼容）| 'return-null'（retries 用尽后返回 null 而不抛错，
 *               让 caller 自己判断 null 决定怎么办，例如 pge.flow.js 把 evaluator 输出失败
 *               当作 verdict-fail 处理而非 kill flow）
 * @returns {Promise<any>} 解析并校验后的值；onFail='return-null' 且 retries 用尽时返回 null
 */
export async function runStructured(runner, prompt, { schema, retries = 1, onFail = 'throw' } = {}) {
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
  if (onFail === 'return-null') return null
  throw new SchemaError(
    `runStructured: ${retries + 1} 次尝试后仍不符合 schema — ${priorError}`,
    priorError,
  )
}

function buildSchemaPrompt(prompt, schema, priorError) {
  let p = `${prompt}\n\n# 输出要求\n只输出一个 JSON，必须符合下面的 JSON Schema（不要任何解释文字）：\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``
  if (priorError) p += `\n\n# 上次输出未通过校验\n${priorError}\n请修正后重新只输出 JSON。`
  return p
}
