import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checkpoint } from '../checkpoint.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowcast-cp-')) }

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

test('Checkpoint.event：结构化事件追加进 run.log.jsonl（不进 state.json）', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rev', dir)
    cp.event('fallback', { from: 'a', to: 'b', reason: '429' })
    cp.event('gate', { name: 'test', status: 'fail', exitCode: 101 })
    const lines = readFileSync(join(dir, 'rev', 'run.log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].event, 'fallback')
    assert.equal(lines[0].reason, '429')
    assert.ok(lines[0].ts, '事件应带时间戳')
    assert.equal(lines[1].event, 'gate')
    // 事件不该污染 state.json
    const state = JSON.parse(readFileSync(join(dir, 'rev', 'state.json'), 'utf8'))
    assert.equal(state.steps.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step：自动捕获 agent 结果的 _meta(model/token) 进步骤记录', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rmeta', dir)
    // 模拟 adapter 返回：字符串 + 挂在 String 包装对象上的 _meta
    const agentResult = Object.assign(String('done'), {
      _meta: { cli: 'claude', model: 'claude-sonnet', inputTokens: 1200, outputTokens: 340 },
    })
    await cp.step('p1.impl', async () => agentResult)
    const onDisk = JSON.parse(readFileSync(join(dir, 'rmeta', 'state.json'), 'utf8'))
    const step = onDisk.steps.find(s => s.key === 'p1.impl')
    assert.equal(step.cli, 'claude')
    assert.equal(step.model, 'claude-sonnet')
    assert.equal(step.inputTokens, 1200)
    assert.equal(step.outputTokens, 340)
    // completed 仍是纯字符串（不被 _meta 污染）
    assert.equal(onDisk.completed['p1.impl'], 'done')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint 报告：record 的步骤无 durationMs 时渲染 "-" 而非 "NaNs"', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rnan', dir)
    cp.record('group.a', { success: true })   // record 不带 durationMs
    cp.done({ done: 1 })
    const report = readFileSync(join(dir, 'rnan', 'report.md'), 'utf8')
    assert.ok(!report.includes('NaN'), '报告不应出现 NaN')
    assert.match(report, /\| group\.a \| done \| - \|/)
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

test('Checkpoint.step: 重入同一 key 抛错（并发双重执行保护）', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-reentry', dir)
    // 第一个 step 还在异步等待中，第二个用相同 key 立刻 step → 应抛错
    let firstStarted = false
    const first = cp.step('s1', async () => {
      firstStarted = true
      await new Promise(res => setTimeout(res, 50))  // 故意挂着
      return 'first'
    })
    // 等第一个开始执行后，立刻并发第二个
    await new Promise(res => setTimeout(res, 5))
    assert.equal(firstStarted, true)
    await assert.rejects(
      () => cp.step('s1', async () => 'second'),
      /in-flight/,
    )
    await first  // 第一个正常完成
    assert.equal(cp.state.completed['s1'], 'first')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: fn 抛错后 _inFlight 清理，同一 key 可重试', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-retry', dir)
    await assert.rejects(
      () => cp.step('s1', async () => { throw new Error('boom') }),
      /boom/,
    )
    // 失败后 inFlight 应已清理，可以重试
    const out = await cp.step('s1', async () => 'recovered')
    assert.equal(out, 'recovered')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── onStep 横切钩子 ───────────────────────────────────────────────

test('onStep: start/done 事件按序触发，携带 key 和 durationMs', async () => {
  const dir = tempDir()
  try {
    const events = []
    const cp = new Checkpoint('hook-done', dir, { onStep: (e) => events.push(e) })
    await cp.step('p1.work', async () => 'result')
    assert.equal(events.length, 2)
    assert.equal(events[0].event, 'start')
    assert.equal(events[0].key, 'p1.work')
    assert.equal(events[1].event, 'done')
    assert.equal(events[1].key, 'p1.work')
    assert.ok(Number.isFinite(events[1].durationMs), 'done 事件应有 durationMs')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: skip 事件在续跑跳过时触发', async () => {
  const dir = tempDir()
  try {
    const cp1 = new Checkpoint('hook-skip', dir)
    await cp1.step('p1', async () => 'cached')

    const events = []
    const cp2 = new Checkpoint('hook-skip', dir, { onStep: (e) => events.push(e) })
    await cp2.step('p1', async () => 'fresh')
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'skip')
    assert.equal(events[0].key, 'p1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: error 事件在步骤失败时触发，携带 error 信息', async () => {
  const dir = tempDir()
  try {
    const events = []
    const cp = new Checkpoint('hook-err', dir, { onStep: (e) => events.push(e) })
    await assert.rejects(() => cp.step('p1', async () => { throw new Error('boom') }))
    const errEvt = events.find(e => e.event === 'error')
    assert.ok(errEvt, 'error 事件应触发')
    assert.equal(errEvt.key, 'p1')
    assert.match(errEvt.error, /boom/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: 钩子抛异常不影响主流程', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('hook-safe', dir, { onStep: () => { throw new Error('hook crash') } })
    const result = await cp.step('p1', async () => 'ok')
    assert.equal(result, 'ok')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: start/skip/error 事件自动写进 run.log.jsonl', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('hook-log', dir)
    await cp.step('p1', async () => 'done')
    // 续跑 skip
    const cp2 = new Checkpoint('hook-log', dir)
    await cp2.step('p1', async () => 'fresh')

    const lines = readFileSync(join(dir, 'hook-log', 'run.log.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l))
    const statuses = lines.map(l => l.status)
    assert.ok(statuses.includes('start'), 'jsonl 应有 start 条目')
    assert.ok(statuses.includes('done'),  'jsonl 应有 done 条目')
    assert.ok(statuses.includes('skip'),  'jsonl 应有 skip 条目')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: timeout 超时抛错并带 key 信息', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-timeout', dir)
    await assert.rejects(
      () => cp.step('slow', async () => new Promise(res => setTimeout(res, 200)), { timeout: 50 }),
      /timed out/,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: 续跑时 _meta 从步骤记录里还原', async () => {
  const dir = tempDir()
  try {
    const cp1 = new Checkpoint('r-meta-resume', dir)
    const agentResult = Object.assign(String('output'), {
      _meta: { cli: 'claude', model: 'claude-sonnet', inputTokens: 500, outputTokens: 100 },
    })
    await cp1.step('impl', async () => agentResult)

    const cp2 = new Checkpoint('r-meta-resume', dir)
    const cached = await cp2.step('impl', async () => 'fresh')
    assert.equal(String(cached), 'output')
    assert.equal(cached._meta?.cli, 'claude')
    assert.equal(cached._meta?.model, 'claude-sonnet')
    assert.equal(cached._meta?.inputTokens, 500)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: 循环里重复调用同一 key 触发 warn（但不报错）', async () => {
  const dir = tempDir()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const cp = new Checkpoint('r-dupkey', dir)
    await cp.step('task', async () => 'first')
    // 同 key 再次调用（模拟循环里忘加下标），应 warn 并返回缓存值
    const out = await cp.step('task', async () => 'second')
    assert.equal(out, 'first', '应返回缓存值')
    assert.ok(warnings.some(w => w.includes('task') && w.includes('下标')), '应打出 warn 提示')
  } finally {
    console.warn = origWarn
    rmSync(dir, { recursive: true, force: true })
  }
})
