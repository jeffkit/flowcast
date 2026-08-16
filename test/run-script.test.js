// run-script.test.js — 动态受限脚本面 runScript
//
// 覆盖：meta 校验先于执行 / parse-check 同步失败 / 五钩子契约（未知选项、
// prompt 校验、label 唯一性）/ 预算对脚本不可见（AGENT_CAP）/ 纯 JSON 结果
// 校验 / agent()=checkpoint（断点续跑：同 runId 重跑跳过已完成步骤）/
// agent-start|end 按 seq 配对 + stopReason / parallel·pipeline·phase·log 透传。
//
// agent() 经 runAgent → 执行器注册表：测试用 registerExecutor 注入假执行器，
// 不触碰真实 CLI。

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runScript } from '../run-script.js'
import { registerExecutor } from '../executor.js'
import { FlowcastError } from '../errors.js'
import { EVENT } from '../events.js'
import { setWorkdir } from '../agent.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowcast-rs-')) }

async function safeRm(dir) {
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (e) {
      if (e.code !== 'ENOTEMPTY' || i === 4) throw e
      await new Promise(res => setTimeout(res, 20 * (i + 1)))
    }
  }
}

// 假执行器：返回 prompt 的确定性回复，记录调用次数（模块级计数器）
let fakeCalls = []
beforeEach(() => { fakeCalls = [] })
registerExecutor('rs-fake', async (prompt) => {
  fakeCalls.push(prompt)
  return `echo:${prompt.length}`
}, { capabilities: { sessionResume: false } })

const META = { name: 'test-flow', description: '测试脚本' }

test('基本执行：agent/log/phase，返回信封 {value, stopReason, agentsStarted}', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    const r = await runScript(`
      log('begin')
      const a = await agent('hello world')
      phase('second')
      const b = await agent('second task', { label: 'b-step' })
      return { a, b }
    `, { meta: META, cli: 'rs-fake', runId: 'rs-basic', dir })
    assert.equal(r.stopReason, 'completed')
    assert.equal(r.agentsStarted, 2)
    assert.deepEqual(r.value, { a: 'echo:11', b: 'echo:11' })
  } finally { await safeRm(dir) }
})

test('meta 校验先于执行：缺失/未知字段/空串 → META_INVALID', async () => {
  const cases = [
    [undefined, 'META_INVALID'],
    [{ name: 'x' }, 'META_INVALID'],
    [{ name: 'x', description: 'y', extra: 1 }, 'META_INVALID'],
    [{ name: '', description: 'y' }, 'META_INVALID'],
  ]
  for (const [meta, code] of cases) {
    await assert.rejects(
      () => runScript('return 1', { meta, dir: tempDir() }),
      (e) => e instanceof FlowcastError && e.code === code,
    )
  }
})

test('parse-check 同步失败 → SCRIPT_PARSE', async () => {
  await assert.rejects(
    () => runScript('const = broken syntax {{{', { meta: META, dir: tempDir() }),
    (e) => e instanceof FlowcastError && e.code === 'SCRIPT_PARSE',
  )
})

test('agent() 契约：prompt 必填、未知选项拒绝、label 唯一', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    await assert.rejects(
      () => runScript("await agent('')", { meta: META, cli: 'rs-fake', dir }),
      (e) => e.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      () => runScript("await agent('x', { nope: 1 })", { meta: META, cli: 'rs-fake', dir }),
      (e) => e.code === 'UNSUPPORTED_OPTION',
    )
    await assert.rejects(
      () => runScript("await agent('a', {label:'dup'}); await agent('b', {label:'dup'})", { meta: META, cli: 'rs-fake', dir }),
      (e) => e.code === 'INVALID_ARGUMENT' && /dup/.test(e.message),
    )
  } finally { await safeRm(dir) }
})

test('预算对脚本不可见：超出 maxTotalAgents → AGENT_CAP', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    await assert.rejects(
      () => runScript("await agent('a'); await agent('b')", { meta: META, cli: 'rs-fake', dir, maxTotalAgents: 1 }),
      (e) => e.code === 'AGENT_CAP',
    )
    assert.equal(fakeCalls.length, 1, '超预算后不得再启动 agent')
  } finally { await safeRm(dir) }
})

test('结果必须纯 JSON：返回函数 → RESULT_UNSERIALIZABLE', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    await assert.rejects(
      () => runScript('return () => 1', { meta: META, cli: 'rs-fake', dir }),
      (e) => e.code === 'RESULT_UNSERIALIZABLE',
    )
  } finally { await safeRm(dir) }
})

test('断点续跑：同 runId 重跑，已完成的 agent 步骤跳过（不重复执行）', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    const script = `
      const a = await agent('first', { label: 's-first' })
      const b = await agent('second', { label: 's-second' })
      return { a, b }
    `
    const r1 = await runScript(script, { meta: META, cli: 'rs-fake', runId: 'rs-resume', dir })
    assert.equal(fakeCalls.length, 2)
    assert.deepEqual(r1.value, { a: 'echo:5', b: 'echo:6' })

    // 重跑同 runId：两个 checkpoint 步骤都 skip，假执行器不再被调用
    fakeCalls = []
    const r2 = await runScript(script, { meta: META, cli: 'rs-fake', runId: 'rs-resume', dir })
    assert.equal(fakeCalls.length, 0, '已完成步骤必须从 checkpoint 跳过')
    assert.deepEqual(r2.value, { a: 'echo:5', b: 'echo:6' }, '跳过的步骤返回缓存值')
  } finally { await safeRm(dir) }
})

test('配对事件：agent-start/agent-end 按 seq 配对写入 run.log.jsonl', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    await runScript("await agent('x', {label:'ev-1'}); await agent('y', {label:'ev-2'})",
      { meta: META, cli: 'rs-fake', runId: 'rs-events', dir })
    const logFile = join(dir, 'rs-events', 'run.log.jsonl')
    assert.ok(existsSync(logFile), 'run.log.jsonl 必须存在')
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const scriptEvents = lines.filter(e => e.event === EVENT.SCRIPT)
    const starts = scriptEvents.filter(e => e.kind === 'agent-start')
    const ends = scriptEvents.filter(e => e.kind === 'agent-end')
    assert.equal(starts.length, 2)
    assert.equal(ends.length, 2)
    assert.deepEqual(starts.map(e => e.seq), ends.map(e => e.seq), 'seq 必须配对')
    assert.ok(ends.every(e => e.stopReason === 'completed'))
    assert.ok(scriptEvents.some(e => e.kind === 'start' && e.name === 'test-flow'))
    assert.ok(scriptEvents.some(e => e.kind === 'end' && e.agentsStarted === 2))
  } finally { await safeRm(dir) }
})

test('parallel/pipeline/phase/log 钩子透传到 flowcast 原语', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    const r = await runScript(`
      phase('fan-out')
      const results = await parallel([
        () => agent('p1', { label: 'par-1' }),
        () => agent('p2', { label: 'par-2' }),
      ])
      const doubled = await pipeline([1, 2], async (n) => n * 2)
      log('done')
      return { results, doubled }
    `, { meta: META, cli: 'rs-fake', runId: 'rs-hooks', dir })
    assert.equal(r.agentsStarted, 2)
    assert.deepEqual(r.value.results, ['echo:2', 'echo:2'])
    assert.deepEqual(r.value.doubled, [2, 4])
  } finally { await safeRm(dir) }
})

test('agent 失败：事件带非 completed stopReason，错误上抛，checkpoint 保留可续跑', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    // 用一个会失败的脚本：调用不存在的执行器
    await assert.rejects(
      () => runScript("await agent('x', { label: 'boom', cli: 'rs-no-such' })",
        { meta: META, runId: 'rs-fail', dir }),
      (e) => e instanceof FlowcastError,
    )
    // 失败路径没有 done() 排干队列：事件写入是异步 appendFile，稍等落盘再读
    await new Promise(res => setTimeout(res, 50))
    const logFile = join(dir, 'rs-fail', 'run.log.jsonl')
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const end = lines.filter(e => e.event === EVENT.SCRIPT && e.kind === 'agent-end').at(-1)
    assert.equal(end.stopReason, 'failed')
    assert.notEqual(end.stopReason, 'completed', '不干净不算成功')
  } finally { await safeRm(dir) }
})
