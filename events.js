// events.js — 跨模块的事件常量与 schema 中央注册表
//
// 目的：消除「dashboard 知道所有事件类型，但写事件的模块各自硬编码字符串」的不对称。
// 新增事件时：(1) 在此文件加一条 const + schema；(2) 让 emit 点 import 这个常量。
//
// 三类事件来源：
//   1. agent 侧事件（fallback / rate-limit）— 走 emitAgentEvent → agentEventSink → run.log.jsonl
//   2. checkpoint 侧事件（gate / loop / group / 未来扩展）— 走 cp.event → run.log.jsonl
//   3. 步骤事件（start / done / skip / error）— 走 Checkpoint._emit，与本表独立（不进 jsonl）
//
// schema 字段约定（字符串描述，便于人读，未来可换 JSON Schema 校验）：
//   - 'string' / 'number' / 'boolean' — 必填
//   - 'optional string' / 'optional number' — 可选

/** 事件类型常量。emit 处用这些常量，避免拼写漂移。 */
export const EVENT = Object.freeze({
  FALLBACK:   'fallback',
  RATE_LIMIT: 'rate-limit',
  GATE:       'gate',
  GROUP:      'group',
  LOOP:       'loop',
})

/**
 * run.log.jsonl 事件 schema 中央注册表。
 *
 * 新增事件类型：(1) 在 EVENT 加常量；(2) 在此表登记 schema + writer/reader；
 * (3) 在 dashboard summarizeEvents 加 case。
 */
export const EVENT_TYPES = {
  [EVENT.FALLBACK]: {
    schema: { scope: "'provider'|'cli'", cli: 'string', from: 'string', to: 'string', reason: 'string' },
    writer: 'emitAgentEvent（adapters.js claudeOnce fallback / executor.js runAgentChain CLI fallback）',
    reader: 'dashboard/collect.js summarizeEvents（按 scope 分桶）',
  },
  [EVENT.RATE_LIMIT]: {
    schema: { cli: 'string', model: 'optional string', availableAt: 'number', source: "'pattern'|'llm'|'default'" },
    writer: 'executor.js runAgentChain（recordRateLimit 完成后 emit）',
    reader: 'dashboard/collect.js summarizeEvents（按 cli/model key 聚合，取最晚 availableAt）',
  },
  [EVENT.GATE]: {
    schema: { name: 'string', status: "'pass'|'fail'", exitCode: 'optional number' },
    writer: 'quality-gate.js runGate 的 onEvent 回调（makeEvent 包装）',
    reader: 'dashboard/collect.js summarizeEvents（gatePass / gateFail 计数）',
  },
  [EVENT.GROUP]: {
    schema: { name: 'string', status: "'done'|'failed'", reason: 'optional string' },
    writer: 'subflow.js fanOut onResult（每组完成后 cp.event 写）',
    reader: 'dashboard/collect.js summarizeEvents（按 status 计数）',
  },
  [EVENT.LOOP]: {
    schema: {
      phase: "'start'|'iterate'|'turn-done'|'budget'|'failed'",
      turn: 'number',
      fromTurn: 'optional number',
      maxTurns: 'optional number',
      reason: 'optional string',
      done: 'optional boolean',
      error: 'optional string',
    },
    writer: 'loop.js emit()（每个阶段发一条）',
    reader: 'dashboard/collect.js summarizeEvents（统计 turn 数 / 预算触发 / 失败）',
  },
}

/** 列出所有已注册事件类型名（调试/校验用）。 */
export function listEventTypes() {
  return Object.keys(EVENT_TYPES)
}