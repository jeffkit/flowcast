import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parallel, pipeline } from '../concurrency.js'

const delay = (ms) => new Promise(res => setTimeout(res, ms))

// ── parallel ─────────────────────────────────────────────────────

test('parallel: strict=false 时某个失败返回 null，其余按序返回', async () => {
  const r = await parallel([
    () => Promise.resolve(1),
    () => Promise.reject(new Error('boom')),
    () => Promise.resolve(3),
  ], { strict: false })
  assert.deepEqual(r, [1, null, 3])
})

test('parallel: strict=true（默认）任一失败立即抛，err.failures 含下标和原始 error', async () => {
  await assert.rejects(
    () => parallel([
      () => Promise.resolve(1),
      () => Promise.reject(new Error('task-1-fail')),
      () => Promise.reject(new Error('task-2-fail')),
    ]),
    (err) => {
      assert.match(err.message, /2 task\(s\) failed/)
      assert.equal(err.failures.length, 2)
      assert.equal(err.failures[0].index, 1)
      assert.match(err.failures[0].error.message, /task-1-fail/)
      return true
    },
  )
})

test('parallel: strict=true 全部成功时正常返回结果', async () => {
  const r = await parallel([() => Promise.resolve('a'), () => Promise.resolve('b')])
  assert.deepEqual(r, ['a', 'b'])
})

test('parallel: concurrency 限并发，峰值不超上限，结果仍按原序', async () => {
  let inFlight = 0
  let peak = 0
  const mk = (v) => async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await delay(10)
    inFlight--
    return v
  }
  const r = await parallel([mk('a'), mk('b'), mk('c'), mk('d'), mk('e')], { concurrency: 2 })
  assert.deepEqual(r, ['a', 'b', 'c', 'd', 'e'])
  assert.ok(peak <= 2, `peak in-flight ${peak} 应 <= 2`)
})

test('parallel: strict=false + onError 回调能捕获失败细节', async () => {
  const errs = []
  const r = await parallel([
    () => Promise.resolve('ok'),
    () => Promise.reject(new Error('fail-me')),
  ], { strict: false, onError: ({ index, error }) => errs.push({ index, msg: error.message }) })
  assert.deepEqual(r, ['ok', null])
  assert.equal(errs.length, 1)
  assert.equal(errs[0].index, 1)
  assert.equal(errs[0].msg, 'fail-me')
})

test('parallel: 空 thunks 数组返回空数组', async () => {
  const r = await parallel([])
  assert.deepEqual(r, [])
})

// ── pipeline（流式：stage 间无 barrier）──────────────────────────

test('pipeline: 两阶段正常流转，结果保持原序', async () => {
  const r = await pipeline([1, 2, 3],
    async (x) => x * 2,
    async (x) => x + 10,
  )
  assert.deepEqual(r, [12, 14, 16])
})

test('pipeline: stage 签名 (prev, item, index)', async () => {
  const r = await pipeline([10, 20],
    async (prev) => prev + 1,
    async (prev, item, index) => `${prev}|item=${item}|i=${index}`,
  )
  assert.deepEqual(r, ['11|item=10|i=0', '21|item=20|i=1'])
})

test('pipeline: 某 item 中途失败 → 该位置 null，不中断其余', async () => {
  const r = await pipeline([1, 2, 3],
    async (x) => { if (x === 2) throw new Error('boom on 2'); return x },
    async (x) => x * 100,
  )
  assert.deepEqual(r, [100, null, 300])
})

test('pipeline: 无 barrier —— 快 item 不必等慢 item 跑完前一 stage', async () => {
  const order = []
  await pipeline([0, 1],
    async (x) => { if (x === 0) await delay(40); return x },
    async (x) => { order.push(`s2:${x}`); return x },
    { concurrency: 2 },
  )
  assert.deepEqual(order, ['s2:1', 's2:0'])
})

test('pipeline: concurrency 限制在飞 item 数', async () => {
  let inflight = 0
  let peak = 0
  await pipeline([1, 2, 3, 4, 5],
    async (x) => { inflight++; peak = Math.max(peak, inflight); await delay(10); inflight--; return x },
    { concurrency: 2 },
  )
  assert.ok(peak <= 2, `峰值并发应 <= 2，实际 ${peak}`)
})

test('pipeline: 空 items / 无 stage 返回空（或原样拷贝）', async () => {
  assert.deepEqual(await pipeline([], async (x) => x + 1), [])
  assert.deepEqual(await pipeline([1, 2]), [1, 2])
})
