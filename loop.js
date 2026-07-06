import { Checkpoint } from './checkpoint.js'
import { runGates } from './quality-gate.js'
import { buildMemorySection, recordLearning } from './memory.js'
import { flowcastDir } from './dirs.js'
import { makeEvent } from './helpers.js'
import { join } from 'path'

// ── loop：goal-driven 循环原语 ⭐ ─────────────────────────────────────
//
// 抽象当下流行的 agent loop 模式（Cursor /loop · Ralph Loop · cursor-goal）：
//   每轮 fresh context 迭代 → 读上轮持久状态 → 跑硬验证门 → 写记忆 → 判达成。
// 与「一条 flow 跑完就退」相比，loop 让 flowcast 能「反复跑到目标达成、且越跑越聪明」，
// 但仍是个【库/同步函数】：跑完即返、不常驻、不是 daemon。谁来周期性叫它
// （cron / 人手 / 产品仓）是上层的事——这守住了 flowcast 不变成 scheduler 的身位。
//
// 不重造状态机：每轮用 Checkpoint 记为 step(turn-N)，天然续跑（重启跳过已完成轮）；
// 硬验证复用 quality-gate 的 runGates；跨-run 经验用 memory.js。
//
// 终止：isDone=true → 'completed'；budget（maxTurns / maxRuntimeMs）触顶 → 'budget_exhausted'；
//       iterate 抛错且无 gate 兜底 → 'failed'（错误上抛，状态已落盘可续跑）。
//
// ⚠️ 并发限制：同一 runId 不能被多个进程并发调用 loop()。
//   Checkpoint._inFlight 只保护单进程内的并发，跨进程无保护——
//   两个进程对同一 runId 并发 loop 会写入重复 turn，导致步骤记录混乱。
//   请确保 loop 实例是单进程独占的（通过 orchestrate 锁、外部进程锁或调度方保证）。

/**
 * @param {function} iterate
 *   async ({ turn, goal, memorySection, lastVerdict, lastResult }) => result
 *   单轮工作体。fresh context 语义由调用方保证（通常每轮 spawn 新 agent 进程）。
 *   loop 只负责注入 goal + 跨-run 记忆 + 上轮结论，并在轮间落盘。
 * @param {object} opts
 *   - goal         {string}   目标描述，注入每轮 iterate
 *   - isDone       {function} async ({turn, result, gateResults, state}) => boolean，达成判定
 *   - gates        {object[]} 可选，每轮跑的质量门（直接传给 runGates）
 *   - gateDeps     {object}   runGates 的 deps（resumeFix/onEvent…）
 *   - memoryScope  {string}   可选，启用跨-run 记忆并按此 scope 读写
 *   - memoryQuery  {string}   召回 query（默认用 goal）
 *   - memoryBaseDir{string}   记忆存储根目录（默认 memory.js 的 .flowcast/memory）
 *   - maxTurns     {number}   轮数封顶（默认 20，呼应 cursor /loop max-turns）
 *   - maxRuntimeMs {number}   可选 wall-clock 封顶
 *   - runId        {string}   Checkpoint run id（默认时间戳）
 *   - stateDir     {string}   Checkpoint 根目录（默认 <flowcastDir>/runs，自动识别 .flowcast/ 或 .flowx/）
 *   - checkpoint   {Checkpoint} 复用外部 Checkpoint（优先于 runId/stateDir）
 *   - onEvent      {function} 观测埋点 (evt) => void
 * @returns {Promise<{status, turns, lastResult, runId}>}
 *   status ∈ 'completed' | 'budget_exhausted'
 */
export async function loop(iterate, opts = {}) {
  const {
    goal = '',
    isDone,
    gates = [],
    gateDeps = {},
    memoryScope = null,
    memoryQuery,
    memoryBaseDir,
    maxTurns = 20,
    maxRuntimeMs,
    runId = `loop-${Date.now()}`,
    stateDir,
    checkpoint,
    onEvent,
  } = opts

  if (typeof iterate !== 'function') throw new TypeError('loop: iterate must be a function')
  if (typeof isDone !== 'function') throw new TypeError('loop: isDone must be a function')

  const resolvedStateDir = stateDir ?? join(flowcastDir(process.cwd()), 'runs')
  const cp = checkpoint ?? new Checkpoint(runId, resolvedStateDir)
  // makeEvent 统一格式：emit 同时写 Checkpoint 日志和外部 onEvent 回调
  const emit = (evt) => {
    const normalized = makeEvent('loop', evt, { runId: cp.runId })
    cp.event('loop', evt)  // cp.event 内部再 makeEvent 包装，此处传原始 evt 避免双重包裹
    if (onEvent) { try { onEvent(normalized) } catch { /* 观测不影响主流程 */ } }
  }

  const startedAt = Date.now()
  let lastVerdict = cp.getLoopState().verdict ?? null
  // 已完成轮数从 Checkpoint 推断，支持续跑：扫已落盘的 turn-N 结果（completed 才算真完成）。
  // 用通用的 countCompletedKeysWithPrefix 而非旧的 countCompletedTurns，
  // 把 'turn-' 前缀约定保持在 loop.js 里，而不是耦合进 Checkpoint。
  let turn = cp.countCompletedKeysWithPrefix('turn-')
  // lastResult 从最后一个已完成 turn 推断，避免额外缓存 key 的 flush 时序缺口。
  // 续跑时从最后一个完成 turn 的旁路存储里读完整 lastResult（getStepResult 透明处理 sidecar）
  let lastResult = turn > 0
    ? cp.getStepResult(`turn-${turn}`)?.result
    : undefined

  emit({ phase: 'start', goal, fromTurn: turn, maxTurns })

  // 声明期望最大时长（给 dashboard 自适应僵尸阈值用）：
  // 有 maxRuntimeMs 用它，没声明时按 maxTurns * 经验值（默认 10min/turn）兜底。
  const effectiveExpectMs = maxRuntimeMs ?? Math.max(maxTurns * 10 * 60_000, 10 * 60_000)
  cp.setExpectMaxMs(effectiveExpectMs)

  while (turn < maxTurns) {
    if (maxRuntimeMs && Date.now() - startedAt >= maxRuntimeMs) {
      emit({ phase: 'budget', reason: 'maxRuntimeMs', turn })
      cp.setLoopState({ status: 'budget_exhausted', turns: turn, reason: 'maxRuntimeMs' })
      cp.done({ loopStatus: 'budget_exhausted', turns: turn, reason: 'maxRuntimeMs' })
      return { status: 'budget_exhausted', turns: turn, lastResult, runId: cp.runId }
    }

    const turnNo = turn + 1
    const memorySection = memoryScope
      ? buildMemorySection(memoryScope, { query: memoryQuery ?? goal, baseDir: memoryBaseDir })
      : ''

    let result
    try {
      result = await cp.step(`turn-${turnNo}`, async () => {
        emit({ phase: 'iterate', turn: turnNo })
        const r = await iterate({ turn: turnNo, goal, memorySection, lastVerdict, lastResult })

        // 每轮硬验证：跑质量门（dry-run 下自动判过）。门红灯按其 onFail 策略处理，
        // rollback/resume-fix 仍失败会抛错——错误上抛、状态已落盘，下次可续跑。
        //
        // 把 maxRuntimeMs 的剩余时间透传给每个 gate 作为兜底超时：
        // 防止某个无 timeout 的 gate 意外挂死并完全无视外层预算约束。
        // gate 自身已设 timeout 的保持不变（自身值更保守时不覆盖）。
        let effectiveGates = gates
        if (gates.length && maxRuntimeMs) {
          const remaining = maxRuntimeMs - (Date.now() - startedAt)
          if (remaining > 0) {
            effectiveGates = gates.map(g =>
              g.timeout == null ? { ...g, timeout: remaining } : g
            )
          }
        }
        const gateResults = effectiveGates.length ? await runGates(effectiveGates, gateDeps) : []
        return { result: r, gateResults }
      })
    } catch (e) {
      cp.setLoopState({ status: 'failed' })
      cp.flush()
      emit({ phase: 'failed', turn: turnNo, error: e.message })
      throw e
    }

    const { result: iterResult, gateResults } = result
    lastResult = iterResult

    let done
    try {
      // 传浅克隆+冻结快照，而非直接暴露 cp.state 引用：
      //   1. 防止 isDone 回调意外修改 Checkpoint 内部状态（写 state.xxx 会影响落盘数据）
      //   2. Object.freeze 让 top-level 属性只读（strict mode 下写入抛 TypeError）
      //   3. 向后兼容：快照与 cp.state 形状完全相同，现有 isDone 实现无需改动
      const stateSnapshot = Object.freeze({ ...cp.state })
      done = await isDone({ turn: turnNo, result: iterResult, gateResults, state: stateSnapshot })
    } catch (e) {
      // isDone 抛错：与 iterate 失败同等对待，落盘 failed 状态后向上抛
      cp.setLoopState({ status: 'failed' })
      cp.flush()
      emit({ phase: 'failed', turn: turnNo, error: e.message })
      throw e
    }
    lastVerdict = done ? 'done' : 'continue'
    cp.setLoopState({ verdict: lastVerdict })
    cp.flush()

    // 把本轮结论沉淀进跨-run 记忆（可选）。
    if (memoryScope) {
      recordLearning(memoryScope, {
        topic: `turn ${turnNo}: ${done ? 'goal reached' : 'progress'}`,
        rootCause: null,
        fix: typeof iterResult === 'string' ? iterResult.slice(0, 500) : null,
        tags: ['loop', done ? 'done' : 'progress'],
        runId: cp.runId,
      }, { baseDir: memoryBaseDir })
    }

    turn = turnNo
    emit({ phase: 'turn-done', turn: turnNo, done })

    if (done) {
      cp.setLoopState({ status: 'completed', turns: turnNo })
      cp.done({ loopStatus: 'completed', turns: turnNo })
      return { status: 'completed', turns: turnNo, lastResult, runId: cp.runId }
    }
  }

  emit({ phase: 'budget', reason: 'maxTurns', turn })
  cp.setLoopState({ status: 'budget_exhausted', turns: turn, reason: 'maxTurns' })
  cp.done({ loopStatus: 'budget_exhausted', turns: turn, reason: 'maxTurns' })
  return { status: 'budget_exhausted', turns: turn, lastResult, runId: cp.runId }
}
