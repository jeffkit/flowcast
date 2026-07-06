// concurrency.js — 并发工具原语
//
// 从 agent.js 抽出：parallel（带 barrier）和 pipeline（无 barrier 流水线）。
// 与执行器/HITL/provider 完全解耦，可独立使用和测试。

import { cpus } from 'os'
import { ParallelError } from './errors.js'

// 流式 pipeline 的默认并发上限 = CPU 核数（env FLOWCAST_PIPELINE_CONCURRENCY 覆盖）
function defaultPipelineConcurrency() {
  const v = parseInt(process.env.FLOWCAST_PIPELINE_CONCURRENCY ?? '', 10)
  if (Number.isFinite(v) && v > 0) return v
  try { return Math.max(1, cpus().length) } catch { return 4 }
}

/**
 * 并行跑多个 thunk（() => Promise）。
 *
 * @param {Array<Function>} thunks
 * @param {object} [o]
 * @param {number}   [o.concurrency]  并发上限；缺省 = 全部一起跑。结果按原下标顺序返回。
 * @param {boolean}  [o.strict=true]  错误收集策略：
 *   - true（默认）：等所有任务跑完后，若有失败则统一抛出 `ParallelError`（`err.failures`）。
 *     注意：**不是 fail-fast**——第一个任务失败后，其余任务仍会继续运行到结束。
 *     如需提前停止排队中的任务，请同时传 failFast: true（但已在跑的任务不会被中断）。
 *   - false：失败的 thunk 在对应位置返回 null，其余继续跑；控制台打 [parallel error]。
 *     适合「部分失败可接受」场景（如批量 agent 调用，结果可 fallback）；
 *     调用方务必检查结果数组中的 null，否则失败会被静默丢失。
 *     注意：无法区分「任务失败」和「任务本身返回 null」，如需区分请传 onError。
 * @param {boolean}  [o.failFast=false]  true 时第一个失败立即停止尚未入队的任务。
 *   ⚠️ 两个重要限制：
 *   1. **仅在 concurrency 有限制时有效**：无 concurrency（Promise.all 全量并发）时，所有任务已同时启动，
 *      failFast 无法阻止任何任务运行，退化为 strict 的等待全量完成行为。
 *   2. **已在跑的任务不会被强制中断**：failFast 只停止还未出队的任务，已在运行的仍会执行到结束。
 *      需要真正的中止需配合 AbortController（当前不实现）。
 *   - 与 strict=true 搭配使用：failFast 控制"是否提前停止排队任务"，strict 控制"是否汇总抛出"。
 * @param {Function} [o.onError]  额外的错误回调 ({index, error}) => void，
 *   用于在保持 null 语义（strict=false）的同时追踪失败（区分失败和任务返回 null 的唯一可靠手段）。
 *   strict=true 时同样有效（在汇总抛出前先触发回调）。
 * @returns {Promise<Array>}
 */
export async function parallel(thunks, { concurrency, strict = true, failFast = false, onError } = {}) {
  const failures = []
  let aborted = false  // failFast 模式：第一个失败后停止新任务入队
  const guard = (fn, i) => fn().catch(err => {
    console.warn(`  [parallel error] ${err.message}`)
    if (strict) failures.push({ index: i, error: err })
    if (failFast) aborted = true  // 通知 worker 停止继续取新任务
    if (typeof onError === 'function') {
      try { onError({ index: i, error: err }) } catch { /* 观测不影响主流程 */ }
    }
    return null
  })
  let results
  if (!concurrency || concurrency >= thunks.length) {
    results = await Promise.all(thunks.map((fn, i) => guard(fn, i)))
  } else {
    results = new Array(thunks.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < thunks.length) {
        if (aborted) break  // failFast：有失败时停止领取新任务
        const i = next++
        results[i] = await guard(thunks[i], i)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
  }
  if (strict && failures.length > 0) {
    const msgs = failures.map(f => `[${f.index}] ${f.error.message}`).join('; ')
    throw new ParallelError(`parallel: ${failures.length} task(s) failed — ${msgs}`, failures)
  }
  return results
}

/**
 * 流式 pipeline：每个 item 独立穿过所有 stage，stage 间无 barrier。
 * 快的 item 先跑完，避免「全部 item 等最慢的跑完某 stage 才进下一 stage」的空等。
 *
 * 与 parallel 的区别：parallel 是「一组 thunk 同时跑」的单层 barrier；
 * pipeline 是「多 item 各自串行穿过多 stage」的无 barrier 流水线。
 *
 * 容错：某 item 在任一 stage 抛错 → 该 item 结果置 null（不中断其余）。
 *
 * @param {Array} items
 * @param {...(Function|object)} stages  每个 stage 是 async (prev, item, index) => next；
 *   末位可传 options 对象 `{ concurrency, onError }` 覆盖并发上限或注入错误回调。
 * @param {object} [opts]  末位 options 对象（可选）
 * @param {number} [opts.concurrency]  并发上限（默认 CPU 核数）
 * @param {Function} [opts.onError]  错误回调 ({index, item, error}) => void。
 *   失败的 item 位置为 null，onError 是区分「失败」和「任务本身返回 null」的唯一可靠手段。
 * @returns {Promise<Array>} 与 items 同序的结果数组；失败的 item 位置为 null。
 */
export async function pipeline(items, ...stages) {
  let opts = {}
  if (stages.length && typeof stages[stages.length - 1] !== 'function') {
    opts = stages.pop() || {}
  }
  const list = Array.isArray(items) ? items : []
  if (!list.length || !stages.length) return list.slice()
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? defaultPipelineConcurrency(), list.length))
  const { onError } = opts
  const results = new Array(list.length)
  let next = 0
  const runItem = async (item, index) => {
    let prev = item
    for (let si = 0; si < stages.length; si++) {
      prev = await stages[si](prev, item, index)
    }
    return prev
  }
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      try {
        results[i] = await runItem(list[i], i)
      } catch (e) {
        console.warn(`  [pipeline error] item[${i}] ${e.message}`)
        results[i] = null
        if (typeof onError === 'function') {
          try { onError({ index: i, item: list[i], error: e }) } catch { /* 观测不影响主流程 */ }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}
