import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isDryRun } from '../dry-run.js'
import { resolveAgent } from '../executor.js'
import { runGate } from '../quality-gate.js'

test('isDryRun: 解析 FLOWX_DRY_RUN', () => {
  assert.equal(isDryRun({ FLOWX_DRY_RUN: '1' }), true)
  assert.equal(isDryRun({ FLOWX_DRY_RUN: 'true' }), true)
  assert.equal(isDryRun({ FLOWX_DRY_RUN: '0' }), false)
  assert.equal(isDryRun({ FLOWX_DRY_RUN: 'false' }), false)
  assert.equal(isDryRun({}), false)
})

test('resolveAgent: dry-run 下未知 agent 也给 fake runner', async () => {
  process.env.FLOWX_DRY_RUN = '1'
  try {
    const a = resolveAgent('whatever-undefined', {})
    const out = await a.run('do something')
    assert.equal(out._meta.dryRun, true)
    assert.equal(out._meta.exitCode, 0)
    assert.match(String(out), /\[dry-run\]/)
  } finally {
    delete process.env.FLOWX_DRY_RUN
  }
})

test('resolveAgent: dry-run 下 cursor+provider 仍 fail-fast（校验恒做）', () => {
  process.env.FLOWX_DRY_RUN = '1'
  try {
    assert.throws(
      () => resolveAgent('x', { x: { executor: 'cursor', provider: 'deepseek' } }),
      /不接受外部 provider/,
    )
  } finally {
    delete process.env.FLOWX_DRY_RUN
  }
})

test('runGate: dry-run 下不 spawn、直接判过（即使命令必败）', async () => {
  process.env.FLOWX_DRY_RUN = '1'
  try {
    const r = await runGate({ name: 'test', cmd: 'exit 1', cwd: process.cwd() })
    assert.equal(r.passed, true)
    assert.equal(r.dryRun, true)
  } finally {
    delete process.env.FLOWX_DRY_RUN
  }
})

test('runGate: 非 dry-run 命令失败仍抛错（回归保护）', async () => {
  await assert.rejects(
    () => runGate({ name: 'test', cmd: 'exit 1', cwd: process.cwd(), onFail: 'rollback' }),
    /quality gate 'test' failed/,
  )
})
