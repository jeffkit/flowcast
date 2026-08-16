// run-script.js — 动态受限脚本编排面（runScript）
//
// borrow dsh workflow 工具的脚本契约（见 docs/NOTES-dsh-workflow-borrowings.md 第 1 条），
// 运行时与持久化全是 flowcast 自己的：
//
//   - 五钩子受限面：agent / parallel / pipeline / phase / log + args 注入
//   - 每个 agent() 调用 = 一个 cp.step（checkpoint）——**断点续跑**是本面对
//     dsh 同类面的直接差异化优势（dsh 的 workflow 无 journaling）
//   - agent() 经 runAgent 落到执行器注册表——任意 CLI（claude/codex/dsh/…），
//     呼应 flowcast「各种 agent 之上的编排」定位
//   - 预算（maxTotalAgents）对脚本不可见（dsh 纪律）；meta 校验先于执行；
//     parse-check 同步失败；结果必须纯 JSON
//
// ⚠️ 信任边界（与 dsh 的声明一致）：脚本是模型写的，信任级等同 bash——
// new Function 不是安全沙箱，脚本可访问进程全局。需要真隔离时应在本面
// 之上套 worker/vm（dsh worker-thread 的同款声明）。
//
// 错误码（对齐 dsh WorkflowError 词汇）：SCRIPT_PARSE / META_INVALID /
// INVALID_ARGUMENT / UNSUPPORTED_OPTION / AGENT_CAP / RESULT_UNSERIALIZABLE。

import { Checkpoint } from './checkpoint.js'
import { runAgent } from './agent.js'
import { parallel as fcParallel, pipeline as fcPipeline } from './concurrency.js'
import { assertSafeIdent } from './helpers.js'
import { FlowcastError } from './errors.js'
import { EVENT } from './events.js'

/** 每个脚本 run 的 agent 总预算缺省（dsh 纪律：预算对脚本不可见）。 */
const DEFAULT_MAX_TOTAL_AGENTS = 32

/**
 * 校验 meta 块（dsh 纪律：先于一切执行，未知字段拒绝）。
 * @returns {void} 抛 FlowcastError(META_INVALID)。
 */
function validateMeta(meta) {
  if (meta === undefined || meta === null) {
    throw new FlowcastError('runScript: options.meta 是必填（{name, description}）', 'META_INVALID')
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new FlowcastError(`runScript: meta 必须是对象，收到 ${Array.isArray(meta) ? '数组' : typeof meta}`, 'META_INVALID')
  }
  const allowed = new Set(['name', 'description'])
  for (const key of Object.keys(meta)) {
    if (!allowed.has(key)) {
      throw new FlowcastError(`runScript: meta 未知字段 '${key}'（允许：${[...allowed].join(' / ')}）`, 'META_INVALID')
    }
  }
  for (const key of ['name', 'description']) {
    const v = meta[key]
    if (typeof v !== 'string' || v.trim() === '') {
      throw new FlowcastError(`runScript: meta.${key} 必须是非空字符串`, 'META_INVALID')
    }
  }
}

/** 深度纯 JSON 校验（undefined / 函数 / Symbol / BigInt / 循环引用一律不合格）。 */
function isPlainJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return false
  if (value === null || typeof value !== 'object') return true  // string / number / boolean
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false  // 循环引用
  }
}

/**
 * 运行一段受限编排脚本。脚本体是普通 JavaScript（可用 await），只能触达
 * 注入的五个钩子与 args；每个 agent() 调用一个 checkpoint 步骤，失败后
 * 用同一 runId 重跑会跳过已完成的 agent 步骤（断点续跑）。
 *
 * @param {string} script 脚本函数体（不含 function 声明，直接写语句）
 * @param {object} [options]
 * @param {{name: string, description: string}} [options.meta] 必填的身份与描述
 * @param {object} [options.args] 注入脚本的 args 全局（纯 JSON 对象）
 * @param {string} [options.cli='claude'] agent() 的缺省执行器（可被单次调用覆盖）
 * @param {string} [options.runId] checkpoint runId（重跑同 id = 断点续跑）
 * @param {string} [options.dir] checkpoint 目录（缺省 flowcastDir()）
 * @param {number} [options.maxTotalAgents=32] agent() 总预算（对脚本不可见）
 * @returns {Promise<{value: *|null, stopReason: 'completed', agentsStarted: number}>}
 * @throws {FlowcastError} code ∈ SCRIPT_PARSE / META_INVALID / INVALID_ARGUMENT /
 *   UNSUPPORTED_OPTION / AGENT_CAP / RESULT_UNSERIALIZABLE（执行失败即抛，
 *   checkpoint 保留，续跑可跳过已完成步骤）
 */
export async function runScript(script, options = {}) {
  // ── 校验先于一切执行（dsh 纪律）───────────────────────────────────
  if (typeof script !== 'string' || script.trim() === '') {
    throw new FlowcastError('runScript: script 必须是非空字符串（函数体，不含声明）', 'INVALID_ARGUMENT')
  }
  const { meta, args, cli = 'claude', runId, dir, maxTotalAgents = DEFAULT_MAX_TOTAL_AGENTS } = options
  validateMeta(meta)
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new FlowcastError('runScript: options.args 必须是 JSON 对象（裸列表请包一层字段）', 'INVALID_ARGUMENT')
  }
  if (!Number.isInteger(maxTotalAgents) || maxTotalAgents < 1) {
    throw new FlowcastError(`runScript: maxTotalAgents 必须是正整数，收到 ${maxTotalAgents}`, 'INVALID_ARGUMENT')
  }

  // parse-check 同步失败（AsyncFunction 构造器抛 SyntaxError）
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  let fn
  try {
    fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', `"use strict";\n${script}`)
  } catch (e) {
    throw new FlowcastError(`runScript: 脚本解析失败：${e.message}`, 'SCRIPT_PARSE')
  }

  const cp = new Checkpoint(runId ?? `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, dir)
  cp.event(EVENT.SCRIPT, { kind: 'start', name: meta.name, description: meta.description })

  // ── 钩子实现 ──────────────────────────────────────────────────────
  let agentsStarted = 0
  let seq = 0
  const usedKeys = new Set()

  const AGENT_OPTS = new Set(['label', 'phase', 'cli', 'schema', 'model'])

  const agent = async (prompt, opts = {}) => {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new FlowcastError('agent(): prompt 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new FlowcastError('agent(): 第二参数必须是对象 {label?, phase?, cli?, schema?, model?}', 'INVALID_ARGUMENT')
    }
    for (const key of Object.keys(opts)) {
      if (!AGENT_OPTS.has(key)) {
        throw new FlowcastError(`agent(): 不支持的选项 '${key}'（允许：${[...AGENT_OPTS].join(' / ')}）`, 'UNSUPPORTED_OPTION')
      }
    }
    // 预算对脚本不可见：超限即致命错误（dsh AGENT_CAP 纪律）
    if (agentsStarted >= maxTotalAgents) {
      throw new FlowcastError(`agent(): 超出本次 run 的 agent 总预算 ${maxTotalAgents}`, 'AGENT_CAP')
    }
    agentsStarted++
    const mySeq = ++seq
    const key = opts.label
      ? (() => {
          try {
            assertSafeIdent(opts.label, 'agent label')
          } catch {
            throw new FlowcastError(`agent(): label '${opts.label}' 不合法（字母数字-_ ）`, 'INVALID_ARGUMENT')
          }
          return opts.label
        })()
      : `agent-${mySeq}`
    if (usedKeys.has(key)) {
      throw new FlowcastError(`agent(): label/key '${key}' 已被使用（label 必须唯一）`, 'INVALID_ARGUMENT')
    }
    usedKeys.add(key)
    if (opts.phase) phase(opts.phase)

    cp.event(EVENT.SCRIPT, { kind: 'agent-start', seq: mySeq, key, cli: opts.cli ?? cli })
    try {
      let result = await cp.step(key, () => runAgent(prompt, {
        cli: opts.cli ?? cli,
        ...(opts.schema ? { schema: opts.schema } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      }), { meta: { label: key, phase: opts.phase, cli: opts.cli ?? cli } })
      // checkpoint 的 skip 路径会把字符串结果包成 makeAgentResult 的 String
      // 对象（携带 _meta）；脚本消费方拿到原始值语义更稳（schema 对象不受影响）。
      if (typeof result === 'object' && result instanceof String) result = result.toString()
      cp.event(EVENT.SCRIPT, { kind: 'agent-end', seq: mySeq, key, stopReason: 'completed' })
      return result
    } catch (e) {
      const stopReason = e?.timedOut ? 'timeout' : (e?.name === 'PauseSignal' ? 'paused' : 'failed')
      cp.event(EVENT.SCRIPT, { kind: 'agent-end', seq: mySeq, key, stopReason })
      throw e
    }
  }

  const parallel = (thunks) => fcParallel(thunks)
  const pipeline = (items, ...stages) => fcPipeline(items, ...stages)
  const phase = (title) => {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new FlowcastError('phase(): title 必须是非空字符串', 'INVALID_ARGUMENT')
    }
    cp.event(EVENT.SCRIPT, { kind: 'phase', title })
  }
  const log = (message) => {
    if (typeof message !== 'string') {
      throw new FlowcastError('log(): message 必须是字符串', 'INVALID_ARGUMENT')
    }
    cp.event(EVENT.SCRIPT, { kind: 'log', message })
  }

  // ── 执行 ─────────────────────────────────────────────────────────
  let value
  try {
    value = await fn(agent, parallel, pipeline, phase, log, args ?? {})
  } catch (e) {
    if (e instanceof FlowcastError) throw e
    // 非 flowcast 错误的脚本运行时失败：保留原始信息，包一层可识别错误码
    const wrapped = new FlowcastError(`runScript: 脚本执行失败：${e?.message ?? e}`, 'SCRIPT_RUNTIME')
    wrapped.cause = e
    throw wrapped
  }
  // 无 return 的脚本归一化为 null（dsh 契约：value 是纯 JSON 或 null）；
  // 主动不合法（函数/Symbol/BigInt/循环引用）仍然拒绝。
  if (value === undefined) value = null
  if (!isPlainJson(value)) {
    throw new FlowcastError('runScript: 脚本返回值必须是纯 JSON 数据或 null（函数/Symbol/BigInt/循环引用不行）', 'RESULT_UNSERIALIZABLE')
  }
  // end 事件先于 done() 发射：done() 会排干日志队列（终止路径同步落盘），
  // 这样 end 行保证持久化（事件写入是异步队列，done 之后没人保证 flush）。
  cp.event(EVENT.SCRIPT, { kind: 'end', name: meta.name, agentsStarted, stopReason: 'completed' })
  await cp.done({ name: meta.name, agentsStarted, stopReason: 'completed' })
  return { value: value ?? null, stopReason: 'completed', agentsStarted }
}
