// concurrency.js — 并发工具原语
//
// 从 agent.js 抽出：parallel（带 barrier）和 pipeline（无 barrier 流水线）。
// 与执行器/HITL/provider 完全解耦，可独立使用和测试。

import { cpus } from 'os'

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
 * @param {boolean}  [o.strict=true] 错误处理策略：
 *   - true（默认）：任一失败立即汇总并抛出含 failures 数组的 Error（仍等全部跑完）。
 *     e.failures 是 [{index, error}] 数组，适合「任一失败则整体放弃」场景。
 *   - false：失败的 thunk 在对应位置返回 null，其余继续跑；控制台打 [parallel error]。
 *     适合「部分失败可接受」场景（如批量 agent 调用，结果可 fallback）；
 *     调用方务必检查结果数组中的 null，否则失败会被静默丢失。
 *     注意：无法区分「任务失败」和「任务本身返回 null」，如需区分请传 onError。
 * @param {Function} [o.onError]  strict=false 时额外的错误回调 ({index, error}) => void，
 *   用于在保持 null 语义的同时追踪失败（区分失败和任务返回 null 的唯一可靠手段）。
 * @returns {Promise<Array>}
 */
export async function parallel(thunks, { concurrency, strict = true, onError } = {}) {
  const failures = []
  const guard = (fn, i) => fn().catch(err => {
    console.error(`  [parallel error] ${err.message}`)
    if (strict) failures.push({ index: i, error: err })
    if (typeof onError === 'function') {
      try { onError({ index: i, error: err }) } catch { /* 观测不影响主流程 */ }
    }
    return null
  })
  let results
  if (!concurrency || concurrency >= thunks.length) {
    results = await Promise.all(thunks.map((fn, i) => guard(fn, i)))
  } else {
    results = new Array(thunks.length)
    let next = 0
    const worker = async () => {
      while (next < thunks.length) {
        const i = next++
        results[i] = await guard(thunks[i], i)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
  }
  if (strict && failures.length > 0) {
    const msgs = failures.map(f => `[${f.index}] ${f.error.message}`).join('; ')
    const err = new Error(`parallel: ${failures.length} task(s) failed — ${msgs}`)
    err.failures = failures
    throw err
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
 *   末位可传 options 对象 `{ concurrency }` 覆盖并发上限。
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
        console.error(`  [pipeline error] item[${i}] ${e.message}`)
        results[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}
