import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runGate, runGates } from '../quality-gate.js'

test('绿灯门 → passed', async () => {
  const r = await runGate({ name: 'ok', cmd: 'true' })
  assert.equal(r.passed, true)
  assert.equal(r.attempts, 1)
})

test('红灯 + onFail=rollback → 抛错且带 gate/output', async () => {
  await assert.rejects(
    runGate({ name: 'test', cmd: 'echo FAILLINE >&2; echo out; exit 3', onFail: 'rollback' }),
    (err) => {
      assert.equal(err.gate, 'test')
      assert.equal(err.exitCode, 3)
      assert.match(err.output, /out/)
      assert.match(err.output, /FAILLINE/) // stderr 也被合并
      return true
    },
  )
})

test('红灯 + onFail=autofix → autofixCmd 修好后重验通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gate-'))
  const flag = join(dir, 'fixed')
  // cmd：flag 存在才绿灯；autofixCmd 创建 flag，之后重验通过
  const r = await runGate({
    name: 'fmt',
    cmd: `test -f ${flag}`,
    onFail: 'autofix',
    autofixCmd: `touch ${flag}`,
  })
  assert.equal(r.passed, true)
  assert.equal(r.autofixed, true)
  assert.equal(r.attempts, 2, 'autofix 后应重验一次（attempts=2）')
  assert.equal(existsSync(flag), true, 'autofixCmd 应被执行')
  rmSync(dir, { recursive: true, force: true })
})

test('红灯 + onFail=autofix → autofixCmd 修后重验仍失败 → 抛错', async () => {
  await assert.rejects(
    runGate({ name: 'fmt', cmd: 'exit 1', onFail: 'autofix', autofixCmd: 'true' }),
    (err) => {
      assert.match(err.message, /still failing after autofix/)
      assert.equal(err.gate, 'fmt')
      return true
    },
  )
})

test('红灯 + resume-fix 成功 → 第二次通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gate-rf-'))
  const flag = join(dir, 'patched')
  // cmd：flag 存在则绿灯，否则红灯
  const cmd = `test -f ${flag}`
  let gotOutput = null
  const r = await runGate(
    { name: 'test', cmd, onFail: 'resume-fix' },
    {
      resumeFix: async (output) => {
        gotOutput = output
        await import('child_process').then(({ execSync }) => execSync(`touch ${flag}`))
        return true
      },
    },
  )
  assert.equal(r.passed, true)
  assert.equal(r.attempts, 2)
  assert.equal(r.resumeFixed, true)
  assert.notEqual(gotOutput, null, 'resumeFix 应收到失败输出')
  rmSync(dir, { recursive: true, force: true })
})

test('红灯 + resume-fix 仍失败 → 抛错', async () => {
  await assert.rejects(
    runGate(
      { name: 'test', cmd: 'exit 1', onFail: 'resume-fix' },
      { resumeFix: async () => true }, // 声称修了但 cmd 永远红
    ),
    /quality gate 'test' failed/,
  )
})

test('onEvent：绿灯 emit gate/pass，红灯 emit gate/fail（埋点）', async () => {
  const events = []
  const onEvent = e => events.push(e)
  await runGate({ name: 'ok', cmd: 'true' }, { onEvent })
  assert.deepEqual(events.at(-1), { event: 'gate', name: 'ok', status: 'pass', attempts: 1 })

  await assert.rejects(runGate({ name: 'bad', cmd: 'exit 7', onFail: 'rollback' }, { onEvent }))
  assert.deepEqual(events.at(-1), { event: 'gate', name: 'bad', status: 'fail', exitCode: 7 })
})

test('红灯 + onFail=autofix 但无 autofixCmd → 直接抛错，不重跑检查', async () => {
  await assert.rejects(
    runGate({ name: 'fmt', cmd: 'exit 1', onFail: 'autofix' /* 无 autofixCmd */ }),
    (err) => {
      assert.match(err.message, /no autofixCmd provided/)
      assert.equal(err.gate, 'fmt')
      return true
    },
  )
})

test('runGates 顺序执行，遇红灯即抛', async () => {
  await assert.rejects(
    runGates([
      { name: 'a', cmd: 'true' },
      { name: 'b', cmd: 'exit 2', onFail: 'rollback' },
      { name: 'c', cmd: 'true' },
    ]),
    (err) => { assert.equal(err.gate, 'b'); return true },
  )
})
