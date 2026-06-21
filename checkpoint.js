import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { appendFile } from 'fs/promises'
import { dirname, join } from 'path'
import { flowcastDir } from './dirs.js'
import { assertSafeIdent, makeEvent } from './helpers.js'
import { TimeoutError, FlowcastError } from './errors.js'

/**
 * pause() 抛出此错误，让 flow 入口点（而非库内部）决定是否 process.exit。
 * 这样 finally 块和测试都能正常拦截 pause 信号。
 */
export class PauseSignal extends Error {
  constructor(reason, context = {}) {
    super(reason)
    this.name = 'PauseSignal'
    this.pauseReason = reason
    this.pauseContext = context
  }
}

// 超出此长度则写旁路文件，state.json 只存摘要；可通过 FLOWCAST_RESULT_INLINE_LIMIT 覆盖
const _envInlineLimit = parseInt(process.env.FLOWCAST_RESULT_INLINE_LIMIT ?? '', 10)
const RESULT_INLINE_LIMIT = Number.isFinite(_envInlineLimit) && _envInlineLimit > 0 ? _envInlineLimit : 500
const RESULT_SIDECAR_MARKER = '\x00flowcast:sidecar\x00'  // state.json 里的占位标记

// FNV-32 hash（比 Java-style 31 倍乘法碰撞率低得多），用于生成旁路文件名后缀。
// 目的：两个 key sanitize 后若产生相同的 safe 前缀（如 'a/b' 和 'a_b' 都变成 'a_b'），
// 不同的 hash 后缀能区分它们，防止旁路文件相互覆盖。
function fnv32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

// 从 agent 结果里提取 _meta（cli/model/token），只挑可观测字段，缺省安全返回 {}。
function pickAgentMeta(result) {
  const m = result && result._meta
  if (!m || typeof m !== 'object') return {}
  const out = {}
  if (m.cli != null) out.cli = m.cli
  if (m.model != null) out.model = m.model
  if (Number.isFinite(m.inputTokens)) out.inputTokens = m.inputTokens
  if (Number.isFinite(m.outputTokens)) out.outputTokens = m.outputTokens
  return out
}

export class Checkpoint {
  /**
   * @param {string} runId
   * @param {string} [stateDir]  缺省 = `<flowcastDir>/runs`（新项目 .flowcast/runs，旧项目 .flowx/runs 兼容；dry-run 自动隔离）
   * @param {object} [opts]
   * @param {Function} [opts.onStep]  横切钩子，step() 的 start/done/skip/error 节点自动回调。
   *   签名：({event: 'start'|'done'|'skip'|'error', key, durationMs?, result?, error?, meta?}) => void
   *   抛异常会被吞掉，绝不影响主流程。
   */
  constructor(runId, stateDir = flowcastDir(process.cwd()) + '/runs', { onStep } = {}) {
    // runId 拼入文件路径，必须通过白名单校验（防路径穿越 ../../evil）。
    // generated flow 直接调 new Checkpoint(runId) 也经此处守卫。
    assertSafeIdent(runId, 'runId')
    this.runId = runId
    this.dir = join(stateDir, runId)
    this.path = join(this.dir, 'state.json')
    this.logPath = join(this.dir, 'run.log.jsonl')  // 每行一条结构化日志
    this._inFlight = new Set()  // 重入保护：防止并发 step() 对同一 key 双重执行
    this._seenKeys = new Set() // 当次进程中调用过的 key，用于检测循环里忘加下标的重复 key
    this._onStep = typeof onStep === 'function' ? onStep : null
    this._stepsDir = join(this.dir, 'steps')
    // 日志写队列：将多次 _log() 的 appendFile 调用串行化，防止并发写乱序。
    // run.log.jsonl 是审计日志，不需要同步保证；_flush() 仍同步以确保 state.json 不丢失。
    this._logQueue = Promise.resolve()
    mkdirSync(this.dir, { recursive: true })
    this.state = this._loadState(runId)
    this._sweepSidecarTmp()  // 清理前次 SIGKILL 遗留的 .out.tmp 孤儿
    this._flush()
  }

  // 核心：有缓存就跳过，没有就执行并存档
  async step(key, fn, { meta = {}, timeout } = {}) {
    if (this._seenKeys.has(key) && this.state.completed[key] !== undefined) {
      console.warn(`  [warn] cp.step: key "${key}" 在本次运行中已被调用过，本次将跳过——循环里请给 key 加下标（如 \`${key}-0\`）`)
    }
    this._seenKeys.add(key)
    if (this.state.completed[key] !== undefined) {
      // 续跑时：尝试从旁路文件还原完整结果。
      // _loadResult 在旁路文件丢失或损坏时会清除 completed[key] 并返回 undefined。
      const cached = this._loadResult(key, this.state.completed[key])
      if (cached === undefined) {
        // 旁路文件丢失或损坏：_loadResult 已清除 completed[key] 并打了 warn。
        // 不能继续 skip——回落到下方的 _inFlight + fn() 重新执行。
        this._log({ key, status: 'rerun', reason: 'sidecar-missing-or-corrupted' })
        // fall through（不 return）
      } else {
        console.log(`  [skip] ${key}`)
        this._log({ key, status: 'skip' })
        this._emit({ event: 'skip', key })
        // 从步骤记录里还原 _meta（cli/model/tokens）
        const stepRecord = this.state.steps.find(s => s.key === key)
        if (stepRecord && (stepRecord.cli || stepRecord.model || stepRecord.inputTokens)) {
          const { cli, model, inputTokens, outputTokens } = stepRecord
          return Object.assign(String(cached), {
            _meta: Object.fromEntries(
              Object.entries({ cli, model, inputTokens, outputTokens }).filter(([, v]) => v != null)
            ),
          })
        }
        return cached
      }
    }
    if (this._inFlight.has(key)) {
      const err = new FlowcastError(`Checkpoint.step: key "${key}" is already in-flight (concurrent call detected)`)
      err.code = 'STEP_REENTRY'
      throw err
    }
    this._inFlight.add(key)
    console.log(`  [run]  ${key}`)
    this.state.currentStep = key
    this._flush()
    this._log({ key, status: 'start' })
    this._emit({ event: 'start', key })

    const startedAt = Date.now()
    let result, error

    try {
      if (timeout) {
        let timer
        result = await Promise.race([
          fn(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(`step "${key}" timed out after ${timeout}ms`, { timeoutMs: timeout })), timeout) }),
        ]).finally(() => clearTimeout(timer))
      } else {
        result = await fn()
      }
    } catch (e) {
      error = {
        message: e.message,
        code: e.code,
        gate: e.gate,
        timedOut: e.timedOut,
        exitCode: e.exitCode,
        schemaError: e.schemaError,
        configError: e.configError,
      }
      Object.keys(error).forEach(k => error[k] === undefined && delete error[k])
      const durationMs = Date.now() - startedAt
      this._inFlight.delete(key)
      this._log({ key, status: 'error', error, durationMs, meta })
      this._emit({ event: 'error', key, error, durationMs, meta })
      // 控制台打出完整 error，方便不翻 jsonl 就能诊断（e.message 里已包含 stderr）
      console.error(`  [error] ${key}: ${e.message}`)
      throw e
    }

    const durationMs = Date.now() - startedAt
    this._inFlight.delete(key)
    this.state.completed[key] = this._storeResult(key, result)
    this.state.currentStep = null

    // 自动捕获 agent 结果上挂的 _meta（cli/model/inputTokens/outputTokens）——
    // adapter 用 Object.assign(String(result), {_meta}) 挂在 String 包装对象上，
    // 存进 completed 时会序列化成纯字符串而丢失，这里显式提进步骤元数据，供看板汇总 token/模型。
    const autoMeta = pickAgentMeta(result)
    // 记录到 steps 列表（摘要用）和 jsonl 日志（完整审计用）；显式 meta 优先级最高。
    const stepRecord = { key, status: 'done', durationMs, completedAt: new Date().toISOString(), ...autoMeta, ...meta }
    this.state.steps.push(stepRecord)
    this._log({ key, status: 'done', durationMs, result, meta: { ...autoMeta, ...meta } })
    this._emit({ event: 'done', key, durationMs, result, meta: { ...autoMeta, ...meta } })
    this._flush()
    return result
  }

  // HITL：暂停并落盘，抛 PauseSignal 让 flow 入口点决定是否 process.exit(0)。
  // 不在库内直接 process.exit——这样 finally 块能跑、测试能拦截信号。
  pause(reason, context = {}) {
    console.log(`\n[paused] ${reason}`)
    this.state.status = 'paused'
    this.state.pauseReason = reason
    this.state.pauseContext = context
    this._log({ key: '__pause__', status: 'paused', reason })
    this._flush()
    throw new PauseSignal(reason, context)
  }

  // 标记整个 workflow 完成，生成可读报告
  done(summary = {}) {
    this.state.status = 'completed'
    this.state.completedAt = new Date().toISOString()
    this.state.summary = summary
    this._flush()
    this._writeReport()
  }

  // 是否已记录过某个 key（fan-out 时用来跳过已完成的子任务）
  has(key) { return this.state.completed[key] !== undefined }

  // 并发安全地记录一个已算好的结果（非 fn）。整段同步执行、无 await，
  // 单线程下并发回调也不会交错，适合 parallel/fanOut 里各子任务回写完成状态。
  record(key, result, meta = {}) {
    this.state.completed[key] = this._storeResult(key, result)
    this.state.steps.push({ key, status: 'done', completedAt: new Date().toISOString(), ...meta })
    this._flush()
    return result
  }

  // 记录一条「非步骤」的结构化事件（provider fallback / 质量门结果 / 自定义信号），
  // 只追加进 run.log.jsonl（形如 {ts, event:'fallback'|'gate'|…, ...data}），不进 state.json
  // —— 避免 state 膨胀，同时让看板能从日志里把可观测信号「数据自描述」地读出来。
  // 观测用途，绝不应影响主流程，故吞掉任何写盘异常。
  event(type, data = {}) {
    try { this._log({ event: type, ...data }) } catch { /* 观测失败不影响主流程 */ }
  }

  getPauseContext() { return this.state.pauseContext || {} }
  get status() { return this.state.status }

  /** 立即持久化当前内存状态（公开接口，供 loop 等外部原语在步骤间主动落盘）。 */
  flush() { this._flush() }

  /**
   * 等待所有异步日志写入完成（测试 / 进程退出前用）。
   * run.log.jsonl 的写入是异步的；需要确保日志落盘后再读取时调用此方法。
   * @returns {Promise<void>}
   */
  flushLog() { return this._logQueue }

  // ── loop 协作窄接口（替代 loop.js 直接读写 cp.state.* 的耦合）────
  //
  // loop 原语需要把循环状态（verdict/status/turns/reason）存进 Checkpoint 的 state，
  // 但又不该越权读写 state 任意字段——给一组窄方法让 Checkpoint 自己定义字段形状。
  // 字段命名约定：cp.state.loopVerdict / cp.state.loopStatus / cp.state.loopReason / cp.state.loopTurns

  /** 设置 loop 状态字段（部分更新，未传的不动）。自动 flush 落盘——外部 API 调用即意图已定。 */
  setLoopState({ verdict, status, turns, reason } = {}) {
    if (verdict !== undefined) this.state.loopVerdict = verdict
    if (status !== undefined) this.state.loopStatus = status
    if (turns !== undefined) this.state.loopTurns = turns
    if (reason !== undefined) this.state.loopReason = reason
    this._flush()
  }

  /** 声明本 run 期望最长跑多久（dashboard 自适应僵尸阈值用）。 */
  setExpectMaxMs(ms) {
    if (Number.isFinite(ms) && ms > 0) {
      this.state.expectMaxMs = ms
      this._flush()
    }
  }

  /** 读 loop 状态（verdict/status/turns/reason 任意字段缺失则 undefined）。 */
  getLoopState() {
    return {
      verdict: this.state.loopVerdict,
      status: this.state.loopStatus,
      turns: this.state.loopTurns,
      reason: this.state.loopReason,
    }
  }

  /**
   * 统计已完成的、以指定前缀 + 数字结尾的步骤数。通用方法，解耦具体命名约定。
   * 例：`countCompletedKeysWithPrefix('turn-')` 统计 `turn-1`, `turn-2`, ... 的数量。
   * @param {string} prefix  key 前缀（如 'turn-'）
   */
  countCompletedKeysWithPrefix(prefix) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${escapedPrefix}\\d+$`)
    return Object.keys(this.state.completed ?? {}).filter((k) => re.test(k)).length
  }

  /**
   * @deprecated 使用 `countCompletedKeysWithPrefix('turn-')` 替代。
   *   旧方法将 `turn-N` 命名约定硬编码在 Checkpoint 里，属于 loop 概念泄漏；
   *   新方法通用，调用方（loop.js）自己传前缀，Checkpoint 不感知具体命名规则。
   */
  countCompletedTurns() {
    return this.countCompletedKeysWithPrefix('turn-')
  }

  /**
   * 读取某个已完成步骤的完整结果（透明处理 sidecar 大结果文件）。
   * key 不在 completed 中返回 undefined。
   */
  getStepResult(key) {
    const stored = this.state.completed[key]
    if (stored === undefined) return undefined
    return this._loadResult(key, stored)
  }

  // ── 内部工具 ────────────────────────────────────────────────────

  _loadState(runId) {
    const fresh = () => ({ runId, status: 'running', completed: {}, steps: [], startedAt: new Date().toISOString() })
    if (!existsSync(this.path)) return fresh()
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      // state.json 损坏：旧版还有 .bak 恢复路径（pre-rename 时代的残留兼容），尝试回退。
      // 新版 _flush 改用 rename 原子写，没有 .bak；但用户从旧版本升级可能留有 .bak。
      const bak = this.path + '.bak'
      if (existsSync(bak)) {
        try {
          return JSON.parse(readFileSync(bak, 'utf8'))
        } catch {
          // fall through
        }
      }
      console.warn(`[checkpoint] state.json corrupted, starting fresh (run ${runId})`)
      return fresh()
    }
  }

  // 存储步骤结果：短结果内联进 state.json；长结果写旁路文件，state.json 存占位标记。
  // 旁路文件格式：首行 "string" 或 "json" 标记类型，其余行为实际内容。
  // 写入采用 write-rename 原子模式：先写 .out.tmp，rename 替换 .out。
  // SIGKILL 截断时要么旧 .out 完整（续跑用），要么新 .out.tmp 不完整但 .out 不受影响。
  _storeResult(key, result) {
    const isStr = typeof result === 'string'
    const str = isStr ? result : (result == null ? '' : JSON.stringify(result))
    if (str.length <= RESULT_INLINE_LIMIT) return result  // 短结果直接内联
    mkdirSync(this._stepsDir, { recursive: true })
    // 用 FNV-32 hash 后缀防止不同 key sanitize 后碰撞（如 'a/b' 和 'a_b' 都变成 'a_b'）。
    // FNV-32 比 Java-style 31 倍乘法有更低的碰撞率和更好的雪崩性。
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filename = `${safe}_${fnv32(key).toString(36)}`
    const outPath = join(this._stepsDir, `${filename}.out`)
    const tmpPath = `${outPath}.tmp`
    writeFileSync(tmpPath, (isStr ? 'string\n' : 'json\n') + str, 'utf8')
    renameSync(tmpPath, outPath)
    return RESULT_SIDECAR_MARKER + filename  // state.json 只存占位
  }

  // 读取步骤结果：识别占位标记则从旁路文件还原（含类型反序列化），否则直接返回内联值。
  // 旁路文件在 SIGKILL 时可能写入不完整，或被手动删除（跨机器迁移等场景）——
  // 文件丢失和 JSON.parse 失败都视为"损坏"，清除 completed[key] 让步骤重新执行。
  _loadResult(key, stored) {
    if (typeof stored === 'string' && stored.startsWith(RESULT_SIDECAR_MARKER)) {
      const safe = stored.slice(RESULT_SIDECAR_MARKER.length)
      const p = join(this._stepsDir, `${safe}.out`)
      if (!existsSync(p)) {
        // 旁路文件丢失（如跨机器复制了 state.json 但没带 steps/ 目录，或文件被手动删除）。
        // 与损坏情形一致对待：清除 completed[key]，让步骤重新执行，避免返回脏 MARKER 字符串。
        console.warn(`[checkpoint] 旁路文件丢失，步骤 "${key}" 将重新执行`)
        delete this.state.completed[key]
        this._flush()
        return undefined
      }
      try {
        const raw = readFileSync(p, 'utf8')
        const nl = raw.indexOf('\n')
        const type = nl >= 0 ? raw.slice(0, nl) : 'string'
        const body = nl >= 0 ? raw.slice(nl + 1) : raw
        return type === 'json' ? JSON.parse(body) : body
      } catch (e) {
        console.warn(`[checkpoint] 旁路文件损坏，步骤 "${key}" 将重新执行：${e.message}`)
        delete this.state.completed[key]
        this._flush()
        return undefined
      }
    }
    return stored
  }

  _emit(evt) {
    if (!this._onStep) return
    try { this._onStep(evt) } catch { /* 观测失败不影响主流程 */ }
  }

  _log(entry) {
    // 异步追加日志，通过 _logQueue 串行化（防止并发写乱序）。
    // 吞掉写盘异常——观测日志失败不应影响主流程（与 event() 的 try-catch 原则一致）。
    // makeEvent 统一事件格式（写入 event + type 双字段保证向后兼容）。
    const eventType = entry.event ?? entry.status ?? 'step'
    const { event: _e, status, ...rest } = entry
    const line = JSON.stringify(makeEvent(eventType, { status, ...rest }, { runId: this.runId })) + '\n'
    this._logQueue = this._logQueue
      .then(() => appendFile(this.logPath, line))
      .catch(() => { /* 观测日志写失败，静默忽略 */ })
  }

  // 清理 steps/ 目录下 SIGKILL 遗留的 .out.tmp 孤儿文件（不完整，写到一半被杀）。
  // 在构造时调用一次即可；失败时静默忽略（不影响主流程）。
  _sweepSidecarTmp() {
    try {
      if (!existsSync(this._stepsDir)) return
      for (const name of readdirSync(this._stepsDir)) {
        if (name.endsWith('.out.tmp')) {
          try { unlinkSync(join(this._stepsDir, name)) } catch { /* 单文件失败跳过 */ }
        }
      }
    } catch { /* 扫不动就放弃 */ }
  }

  _flush() {
    // write-rename 原子写：先写 state.json.tmp，rename 替换原 state.json。
    // POSIX rename 是原子操作，SIGKILL 截断时要么旧文件完整要么新文件完整，
    // 不会出现「正文写一半」状态。._loadState 不再需要 .bak 恢复逻辑（保留兜底兼容旧版升级）。
    const data = JSON.stringify(this.state, null, 2)
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, data)
    renameSync(tmp, this.path)
  }

  // 生成人可读的 Markdown 报告
  _writeReport() {
    const s = this.state
    const totalMs = new Date(s.completedAt) - new Date(s.startedAt)
    const totalSec = (totalMs / 1000).toFixed(1)

    const stepRows = s.steps.map(st => {
      // cp.record（fanOut 各组回写）不带 durationMs，旧版会渲染成 "NaNs"；此处守卫为 "-"。
      const sec = Number.isFinite(st.durationMs) ? `${(st.durationMs / 1000).toFixed(1)}s` : '-'
      const cli = st.cli ?? '-'
      return `| ${st.key} | ${st.status} | ${sec} | ${cli} |`
    }).join('\n')

    const report = `# Workflow Run Report

**Run ID**: ${s.runId}
**Status**: ${s.status}
**Started**: ${s.startedAt}
**Completed**: ${s.completedAt}
**Total time**: ${totalSec}s

## Summary
${Object.entries(s.summary).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

## Steps

| Step | Status | Duration | CLI |
|------|--------|----------|-----|
${stepRows}

## Full log
See \`run.log.jsonl\` for complete inputs/outputs per step.
`
    writeFileSync(join(this.dir, 'report.md'), report)
    console.log(`\n📋 报告已生成：${join(this.dir, 'report.md')}`)
  }
}
