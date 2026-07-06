// helpers.js — 跨模块复用的纯函数 / 校验器。
//
// 任何模块要校验"任务标识符"（task.name / failure-context tag / 子 runId 等）
// 都要走 assertSafeIdent。理由：这些字符串最终拼到文件路径里，
// path.join 不阻止 `..` 解析，必须用白名单字符校验拦在源头。

import { PathError } from './errors.js'

// 标识符白名单：字母数字开头结尾，中间允许 . _ -
// （跟 subflow.js 原本内联的正则一致，提出来共享）
const IDENT_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

/**
 * 校验任务/资源标识符。
 * @param {string} name
 * @param {string} [field='name']  出错信息里用的字段名
 * @throws {PathError} 不安全字符
 */
export function assertSafeIdent(name, field = 'name') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new PathError(
      `${field} '${name}' 包含非法字符。` +
      `只允许字母数字、点、连字符、下划线，且必须以字母数字开头和结尾。`,
    )
  }
  return name
}

// ── 统一事件 schema ──────────────────────────────────────────────────
//
// cp.event / setAgentEventSink / quality-gate onEvent / verify 等各模块的事件格式不统一，
// 导致 dashboard 难以跨模块聚合。
// makeEvent() 提供规范化辅助：将各模块的原始 payload 统一包装成
//   { event, type, runId?, ts, durationMs?, ...payload }
//
// 双字段兼容策略：
//   - `event`：现有 run.log.jsonl 和 dashboard 使用此字段做路由（向后兼容，不能删）
//   - `type`：新标准字段，与 `event` 保持同值，供未来统一迁移
// 调用方直接用 makeEvent，不再手动构造 { event: ..., ts: ... }。

/**
 * 构造符合统一 FlowcastEvent schema 的事件对象。
 * @param {string}  eventType  事件类型（如 'gate' / 'fallback' / 'loop'）
 * @param {object}  [payload]  额外字段（与 event/type/runId/ts/durationMs 合并）
 * @param {object}  [ctx]      上下文注入
 * @param {string}  [ctx.runId]       run 标识（来自 Checkpoint.runId 或 orchestrate 的 runId）
 * @param {number}  [ctx.durationMs]  事件耗时（ms）
 * @returns {{ event: string, type: string, ts: string, runId?: string, durationMs?: number }}
 */
export function makeEvent(eventType, payload = {}, { runId, durationMs } = {}) {
  const evt = {
    event: eventType,  // 向后兼容：dashboard 和 run.log.jsonl 读 event 字段
    type: eventType,   // 新标准字段：与 event 同值，供未来统一迁移
    ts: new Date().toISOString(),
  }
  if (runId !== undefined) evt.runId = runId
  if (durationMs !== undefined) evt.durationMs = durationMs
  return Object.assign(evt, payload)
}

// ── agent 结果类型 ──────────────────────────────────────────────────────────
//
// 旧写法：Object.assign(String(text), { _meta: {...} })
//   问题：String() 在函数调用语境返回原始值，Object.assign 对其自动装箱；
//   装箱后的 String 对象 typeof === 'object'，JSON.stringify 正确序列化为字符串（丢弃 _meta），
//   但代码阅读者无从知晓这个"特殊字符串"的来龙去脉，且所有消费方都要专门处理。
//
// 新写法：makeAgentResult(text, meta)
//   使用 new String(text)（显式装箱，意图清晰），附加 .text 显式访问器和不可枚举 _meta。
//   行为与旧写法完全兼容：模板字面量、字符串方法、JSON.stringify 均正常工作。
//   新增：agentText(r) / agentMeta(r) 两个工具函数，类型安全地提取 text 和 meta，
//   消除调用方的"如果它是 String 对象则用 valueOf，否则用 String()" 防御代码。
//
// 兼容性矩阵（r = makeAgentResult("hi", {cli: 'claude'})）：
//   `${r}`               → 'hi'        ✅ （String.prototype.toString()）
//   r + ''               → 'hi'        ✅ （valueOf() 自动调用）
//   String(r)            → 'hi'        ✅ （调用 valueOf()）
//   r.includes('h')      → true        ✅ （String.prototype 方法）
//   r.length             → 2           ✅ （String.prototype.length）
//   JSON.stringify(r)    → '"hi"'      ✅ （String 对象序列化为 JSON 字符串，_meta 因不可枚举被跳过）
//   typeof r             → 'object'    ⚠️  （这是 String 包装对象的固有行为，无法改变）
//   r.text               → 'hi'        ✅ （显式 text 访问器，类型安全）
//   agentText(r)         → 'hi'        ✅ （兼容原始字符串 + String 对象 + {text} 对象）

/**
 * 创建带元数据的 agent 结果对象。
 * 行为上与 String 完全兼容（模板字面量/字符串方法/JSON.stringify），
 * 同时通过显式 `.text` 和 `._meta` 属性让意图更清晰。
 *
 * @param {string} text   agent 输出文本
 * @param {object} [meta] 元数据（cli / model / inputTokens / outputTokens 等）
 * @returns {String & { text: string, _meta: object }}
 */
export function makeAgentResult(text, meta = {}) {
  const wrapper = new String(String(text ?? ''))
  // text：显式访问器，类型安全提取文本（与旧的 Object.assign(String(), ...) 对称）
  wrapper.text = String(text ?? '')
  // _meta：不可枚举，JSON.stringify 时不会出现在序列化结果中（保持 String 对象的"纯字符串"序列化）
  Object.defineProperty(wrapper, '_meta', {
    value: meta,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  return wrapper
}

/**
 * 类型安全地从 agent 结果中提取文本。
 * 兼容：string primitive / String 对象（新旧写法） / { text: string } 对象。
 * @param {any} result
 * @returns {string}
 */
export function agentText(result) {
  if (typeof result === 'string') return result
  if (result instanceof String) return result.valueOf()
  if (result !== null && typeof result === 'object' && typeof result.text === 'string') return result.text
  return String(result ?? '')
}

/**
 * 类型安全地从 agent 结果中提取 _meta（不存在时返回空对象）。
 * @param {any} result
 * @returns {object}
 */
export function agentMeta(result) {
  return (result !== null && typeof result === 'object' && result._meta) || {}
}