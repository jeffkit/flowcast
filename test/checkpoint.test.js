import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checkpoint } from '../checkpoint.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowx-cp-')) }

test('Checkpoint.record/has: 同步记录已算好的结果，可被 has 命中', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r1', dir)
    assert.equal(cp.has('g.a'), false)
    const v = cp.record('g.a', { success: true, reason: 'ok' })
    assert.deepEqual(v, { success: true, reason: 'ok' })
    assert.equal(cp.has('g.a'), true)
    // 落盘可被新实例读回（续跑语义）
    const cp2 = new Checkpoint('r1', dir)
    assert.equal(cp2.has('g.a'), true)
    assert.deepEqual(cp2.state.completed['g.a'], { success: true, reason: 'ok' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.record: 并发回调按 fan-out 方式写多个 key 都不丢', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r2', dir)
    // 模拟多个子任务并发完成后各自 record（record 同步，不会交错丢写）
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(async (k) => {
      await new Promise(res => setTimeout(res, Math.random() * 10))
      cp.record(`g.${k}`, { success: true })
    }))
    for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(cp.has(`g.${k}`), true)
    // state.json 最终包含全部 5 条
    const onDisk = JSON.parse(readFileSync(join(dir, 'r2', 'state.json'), 'utf8'))
    assert.equal(Object.keys(onDisk.completed).length, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step 仍跳过已 record 的 key', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r3', dir)
    cp.record('s1', 'pre-done')
    let ran = false
    const out = await cp.step('s1', async () => { ran = true; return 'fresh' })
    assert.equal(ran, false)        // 已记录 → 不再执行
    assert.equal(out, 'pre-done')   // 返回已存结果
    assert.ok(existsSync(join(dir, 'r3', 'state.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
