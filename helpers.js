// helpers.js — 跨模块复用的纯函数 / 校验器。
//
// 任何模块要校验"任务标识符"（task.name / failure-context tag / 子 runId 等）
// 都要走 assertSafeIdent。理由：这些字符串最终拼到文件路径里，
// path.join 不阻止 `..` 解析，必须用白名单字符校验拦在源头。

// 标识符白名单：字母数字开头结尾，中间允许 . _ -
// （跟 subflow.js 原本内联的正则一致，提出来共享）
const IDENT_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

/**
 * 校验任务/资源标识符。
 * @param {string} name
 * @param {string} [field='name']  出错信息里用的字段名
 * @throws {Error} 不安全字符
 */
export function assertSafeIdent(name, field = 'name') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(
      `${field} '${name}' contains unsafe characters. ` +
      `Only alphanumeric, dots, dashes, and underscores are allowed, ` +
      `and must start/end with alphanumeric.`,
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