import { test } from 'node:test'
import assert from 'node:assert/strict'

import { verifyAdversarial } from '../verify.js'
import { VerifyError } from '../errors.js'

// 注入 runner：按 prompt 里的 lens / 顺序返回结构化 verdict 文本，省真实 API。
function fakeRunner(map) {
  let i = 0
  return async (prompt) => {
    // 若按 lens 路由
    for (const [lens, real] of Object.entries(map.byLens ?? {})) {
      if (prompt.includes(`「${lens}」`)) return JSON.stringify({ real, reason: lens })
    }
    // 否则按调用序返回
    const seq = map.seq ?? []
    const real = seq[i] ?? map.default ?? true
    i++
    return JSON.stringify({ real, reason: `vote-${i}` })
  }
}

test('verifyAdversarial: 全票成立 → verdict true', async () => {
  const r = await verifyAdversarial('地球是圆的', {
    voters: 3, runner: fakeRunner({ default: true }),
  })
  assert.equal(r.verdict, true)
  assert.equal(r.survived, 3)
  assert.equal(r.total, 3)
})

test('verifyAdversarial: 默认过半阈值（3 票里 1 成立 → false）', async () => {
  const r = await verifyAdversarial('可疑论断', {
    voters: 3, runner: fakeRunner({ seq: [true, false, false] }),
  })
  assert.equal(r.threshold, 2)
  assert.equal(r.survived, 1)
  assert.equal(r.verdict, false)
})

test('verifyAdversarial: 过半成立 → true', async () => {
  const r = await verifyAdversarial('多数支持', {
    voters: 3, runner: fakeRunner({ seq: [true, true, false] }),
  })
  assert.equal(r.survived, 2)
  assert.equal(r.verdict, true)
})

test('verifyAdversarial: lenses 每视角一票，记录 lens', async () => {
  const r = await verifyAdversarial('多视角检查', {
    lenses: ['correctness', 'security', 'repro'],
    runner: fakeRunner({ byLens: { correctness: true, security: false, repro: true } }),
  })
  assert.equal(r.total, 3)
  assert.equal(r.survived, 2)
  assert.equal(r.verdict, true)
  assert.ok(r.votes.some(v => v.lens === 'security' && v.real === false))
})

test('verifyAdversarial: 自定义 threshold（要求全票）', async () => {
  const r = await verifyAdversarial('严格门槛', {
    voters: 3, threshold: 3, runner: fakeRunner({ seq: [true, true, false] }),
  })
  assert.equal(r.threshold, 3)
  assert.equal(r.verdict, false)
})

test('verifyAdversarial: 所有 voter 均失败 → 抛 VerifyError，voterErrors 长度等于 voters 数', async () => {
  const voters = 3
  let callCount = 0
  const failRunner = async () => {
    callCount++
    throw new Error(`voter ${callCount} failed`)
  }
  await assert.rejects(
    () => verifyAdversarial('all fail', { voters, runner: failRunner }),
    (err) => {
      assert.ok(err instanceof VerifyError, `应为 VerifyError，实际：${err?.constructor?.name}`)
      assert.equal(err.voterErrors.length, voters, `voterErrors.length 应为 ${voters}`)
      return true
    },
  )
})

test('verifyAdversarial: dry-run 全票通过且不调 runner', async () => {
  process.env.FLOWCAST_DRY_RUN = '1'
  try {
    let called = false
    const r = await verifyAdversarial('x', { voters: 3, runner: async () => { called = true; return '{}' } })
    assert.equal(called, false)
    assert.equal(r.verdict, true)
    assert.equal(r.dryRun, true)
  } finally {
    delete process.env.FLOWCAST_DRY_RUN
  }
})
