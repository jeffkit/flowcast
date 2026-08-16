// checkpoint-stopreason.test.js — stopReason 封闭枚举与「不干净不算成功」纪律
//
// borrow 自 dsh workflow 的 stop-reason 词汇（见
// docs/NOTES-dsh-workflow-borrowings.md 第 3 条）：
//   - step 成功记录 stopReason: 'completed'
//   - step 失败记录进 state.steps（原来只进 jsonl）且带归一化 stopReason
//     （timeout / paused / failed）
//   - run 级：done() → 'completed'，pause() → 'paused'
//   - isSuccessStop 是唯一成功判断：非 completed 一律 false

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checkpoint, PauseSignal, STOP_REASONS, isSuccessStop } from '../checkpoint.js'
import { TimeoutError, FlowcastError } from '../errors.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowcast-sr-')) }

async function safeRm(dir) {
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (e) {
      if (e.code !== 'ENOTEMPTY' || i === 4) throw e
      await new Promise(res => setTimeout(res, 20 * (i + 1)))
    }
  }
}

test('STOP_REASONS 封闭词汇 + isSuccessStop 纪律', () => {
  assert.deepEqual([...STOP_REASONS], ['completed', 'failed', 'timeout', 'paused'])
  assert.equal(isSuccessStop('completed'), true)
  for (const r of ['failed', 'timeout', 'paused', '', undefined, 'COMPLETED', 'ok']) {
    assert.equal(isSuccessStop(r), false, `isSuccessStop(${JSON.stringify(r)}) 必须 false`)
  }
})

test('step 成功：stepRecord 带 stopReason: completed', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('sr-ok', dir)
    await cp.step('s1', async () => 42)
    const rec = cp.state.steps.find(s => s.key === 's1')
    assert.equal(rec.status, 'done')
    assert.equal(rec.stopReason, 'completed')
    await cp.done({ n: 1 })
    assert.equal(cp.state.stopReason, 'completed')
  } finally { await safeRm(dir) }
})

test('step 失败：记录进 state.steps 且 stopReason 归一化（普通错误→failed）', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('sr-fail', dir)
    await assert.rejects(
      () => cp.step('s1', async () => { throw new FlowcastError('boom') }),
      /boom/,
    )
    const rec = cp.state.steps.find(s => s.key === 's1')
    assert.ok(rec, '失败步骤必须进 state.steps（原来只进 jsonl）')
    assert.equal(rec.status, 'error')
    assert.equal(rec.stopReason, 'failed')
    assert.equal(isSuccessStop(rec.stopReason), false)
  } finally { await safeRm(dir) }
})

test('step 超时：TimeoutError 映射 stopReason: timeout', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('sr-to', dir)
    await assert.rejects(
      () => cp.step('s1', () => new Promise(() => {}), { timeout: 30 }),
      (e) => e instanceof TimeoutError,
    )
    const rec = cp.state.steps.find(s => s.key === 's1')
    assert.equal(rec.stopReason, 'timeout')
    assert.equal(isSuccessStop(rec.stopReason), false)
  } finally { await safeRm(dir) }
})

test('step 暂停：PauseSignal 映射 stopReason: paused，run 级同步落 state', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('sr-pause', dir)
    await assert.rejects(
      () => cp.step('s1', async () => cp.pause('等人工确认')),
      (e) => e instanceof PauseSignal,
    )
    const rec = cp.state.steps.find(s => s.key === 's1')
    assert.equal(rec.stopReason, 'paused')
    assert.equal(cp.state.stopReason, 'paused')
    assert.equal(cp.state.status, 'paused')
    assert.equal(isSuccessStop(cp.state.stopReason), false)
  } finally { await safeRm(dir) }
})

test('record()：同步记录也带 stopReason: completed', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('sr-rec', dir)
    cp.record('k', 7)
    const rec = cp.state.steps.find(s => s.key === 'k')
    assert.equal(rec.stopReason, 'completed')
  } finally { await safeRm(dir) }
})
