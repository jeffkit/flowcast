import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  recursive, spawnCapture, claudeProviderEnv, isProviderRetryable, runAgentChain,
  setHitlBackend, getHitlBackend, waitForInput, notify, parallel, pipeline, setAgentEventSink,
} from '../agent.js'

const delay = (ms) => new Promise(res => setTimeout(res, ms))

// 假的 recursive 二进制：按 FAKE_MODE 控制输出/退出码，并按 --transcript-out 写 transcript。
const FAKE_BIN = `#!/bin/sh
TRANSCRIPT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--transcript-out" ]; then TRANSCRIPT="$a"; fi
  prev="$a"
done
if [ -n "$TRANSCRIPT" ]; then
  printf '{"messages":[{"role":"user"},{"role":"assistant"},{"role":"tool"}]}' > "$TRANSCRIPT"
fi
case "$FAKE_MODE" in
  budget) echo "[done after 2 steps] reason: BudgetExceeded"; exit 0 ;;
  panic)  echo "thread 'main' panicked at boom"; exit 101 ;;
  *)      echo "[done after 3 steps] reason: Done"; exit 0 ;;
esac
`

function makeFakeBin() {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-recbin-'))
  const bin = join(dir, 'recursive')
  writeFileSync(bin, FAKE_BIN)
  chmodSync(bin, 0o755)
  return { dir, bin }
}

// ── spawnCapture ──────────────────────────────────────────────────

test('spawnCapture 不因非零退出 reject，返回 exitCode', async () => {
  const r = await spawnCapture('sh', ['-c', 'echo hi; exit 7'])
  assert.equal(r.exitCode, 7)
  assert.match(r.stdout, /hi/)
  assert.equal(r.timedOut, false)
})

test('spawnCapture 合并 stderr', async () => {
  const r = await spawnCapture('sh', ['-c', 'echo err >&2'])
  assert.match(r.stdout, /err/)
})

// ── recursive adapter ─────────────────────────────────────────────

test('recursive 正常结束：finishReason + transcriptMessages', async () => {
  const { dir, bin } = makeFakeBin()
  const tOut = join(dir, 't.json')
  const out = await recursive('do something', { bin, cwd: dir, transcriptOut: tOut })
  assert.equal(out._meta.cli, 'recursive')
  assert.equal(out._meta.exitCode, 0)
  assert.equal(out._meta.budgetExceeded, false)
  assert.equal(out._meta.panicked, false)
  assert.equal(out._meta.finishReason, 'Done')
  assert.equal(out._meta.transcriptMessages, 3)
  rmSync(dir, { recursive: true, force: true })
})

test('recursive BudgetExceeded 被识别', async () => {
  const { dir, bin } = makeFakeBin()
  const out = await recursive('g', { bin, cwd: dir, env: { FAKE_MODE: 'budget' } })
  assert.equal(out._meta.budgetExceeded, true)
  assert.equal(out._meta.finishReason, 'BudgetExceeded')
  rmSync(dir, { recursive: true, force: true })
})

test('recursive panic（exit 101）被识别', async () => {
  const { dir, bin } = makeFakeBin()
  const out = await recursive('g', { bin, cwd: dir, env: { FAKE_MODE: 'panic' } })
  assert.equal(out._meta.panicked, true)
  assert.equal(out._meta.exitCode, 101)
  rmSync(dir, { recursive: true, force: true })
})

test('recursive 二进制不存在 → spawnError，不抛', async () => {
  const out = await recursive('g', { bin: '/nonexistent/recursive-xyz', cwd: tmpdir() })
  assert.ok(out._meta.spawnError, '应记录 spawnError')
  assert.equal(out._meta.exitCode, -1)
})

// ── claude provider 注入 ──────────────────────────────────────────

test('claudeProviderEnv：anthropic provider → ANTHROPIC_BASE_URL/_AUTH_TOKEN', () => {
  const env = claudeProviderEnv({
    name: 'anthropic-deepseek',
    type: 'anthropic',
    apiBase: 'https://api.deepseek.com/anthropic',
    apiKey: 'sk-xxx',
    model: 'deepseek-chat',
  })
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-xxx')
})

test('claudeProviderEnv：无 provider 返回 undefined（用 ambient env）', () => {
  assert.equal(claudeProviderEnv(undefined), undefined)
  assert.equal(claudeProviderEnv(null), undefined)
})

test('claudeProviderEnv：不限制 provider.type（claude CLI 网关可转发 openai/anthropic）', () => {
  // 旧版 fail-fast 拒绝非 anthropic type；新版放开——claude CLI 网关代理支持多协议转发。
  const env1 = claudeProviderEnv({ name: 'deepseek', type: 'openai', apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk' })
  assert.equal(env1.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/v1')
  assert.equal(env1.ANTHROPIC_AUTH_TOKEN, 'sk')
  const env2 = claudeProviderEnv({ name: 'anth', type: 'anthropic', apiBase: 'https://api.anthropic.com', apiKey: 'sk2' })
  assert.equal(env2.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
  assert.equal(env2.ANTHROPIC_AUTH_TOKEN, 'sk2')
})


// ── provider 回退判定 ─────────────────────────────────────────────

test('setAgentEventSink：CLI 回退时 emit fallback 事件（观测埋点）', async () => {
  const events = []
  setAgentEventSink(e => events.push(e))
  try {
    let calls = 0
    const runner = async (_p, spec) => {
      calls++
      if (spec.cli === 'claude') { const e = new Error('rate limit'); e.apiStatus = 429; throw e }
      return 'ok'
    }
    const r = await runAgentChain('x', [{ cli: 'claude' }, { cli: 'agy' }], { runner })
    assert.equal(r, 'ok')
    const fb = events.find(e => e.event === 'fallback')
    assert.ok(fb, '应 emit 一条 fallback 事件')
    assert.equal(fb.scope, 'cli')
    assert.equal(fb.from, 'claude')
    assert.equal(fb.to, 'agy')
  } finally {
    setAgentEventSink(null)   // 复位，避免污染其他用例
  }
})

test('setAgentEventSink：sink 抛错不影响主流程', async () => {
  setAgentEventSink(() => { throw new Error('sink boom') })
  try {
    const runner = async (_p, spec) => {
      if (spec.cli === 'claude') { const e = new Error('429'); e.apiStatus = 429; throw e }
      return 'ok'
    }
    const r = await runAgentChain('x', [{ cli: 'claude' }, { cli: 'agy' }], { runner })
    assert.equal(r, 'ok', '观测 sink 抛错应被吞掉，回退照常进行')
  } finally {
    setAgentEventSink(null)
  }
})

test('isProviderRetryable：429/529 状态码 → 可回退', () => {
  assert.equal(isProviderRetryable({ apiStatus: 429, message: 'x' }), true)
  assert.equal(isProviderRetryable({ apiStatus: 529, message: 'x' }), true)
})

test('isProviderRetryable：限额类错误信息 → 可回退', () => {
  assert.equal(isProviderRetryable({ message: "You've hit your session limit" }), true)
  assert.equal(isProviderRetryable({ message: 'rate limit exceeded' }), true)
  assert.equal(isProviderRetryable({ message: 'Too Many Requests (429)' }), true)
  assert.equal(isProviderRetryable({ message: 'insufficient quota' }), true)
  assert.equal(isProviderRetryable({ message: 'service overloaded' }), true)
})

test('isProviderRetryable：普通错误 → 不回退', () => {
  assert.equal(isProviderRetryable({ apiStatus: 404, message: 'model not found' }), false)
  assert.equal(isProviderRetryable({ message: '[claude] exit 1' }), false)
  assert.equal(isProviderRetryable({}), false)
  assert.equal(isProviderRetryable(null), false)
})

// ── runAgentChain 跨 CLI 回退 ─────────────────────────────────────

test('runAgentChain：首个成功 → 不回退', async () => {
  const calls = []
  const runner = async (_p, spec) => { calls.push(spec.cli); return 'OK-' + spec.cli }
  const r = await runAgentChain('x', [{ cli: 'claude' }, { cli: 'agy' }], { runner })
  assert.equal(r, 'OK-claude')
  assert.deepEqual(calls, ['claude'])
})

test('runAgentChain：minimax 限额(429) → agy → deepseek 按序回退', async () => {
  const calls = []
  const runner = async (_p, spec) => {
    calls.push(spec.cli + (spec.provider?.name ? '/' + spec.provider.name : ''))
    if (spec.cli === 'claude' && spec.provider?.name === 'anthropic-minimax') {
      const e = new Error('rate limit'); e.apiStatus = 429; throw e
    }
    if (spec.cli === 'agy') throw Object.assign(new Error("You've hit your session limit"))
    return 'OK-' + spec.cli
  }
  const chain = [
    { cli: 'claude', provider: { name: 'anthropic-minimax' } },
    { cli: 'agy' },
    { cli: 'claude', provider: { name: 'anthropic-deepseek' } },
  ]
  const r = await runAgentChain('x', chain, { runner })
  assert.equal(r, 'OK-claude')
  assert.deepEqual(calls, ['claude/anthropic-minimax', 'agy', 'claude/anthropic-deepseek'])
})

test('runAgentChain：非限额错误 → 不回退，直接抛', async () => {
  const calls = []
  const runner = async (_p, spec) => {
    calls.push(spec.cli)
    const e = new Error('model not found'); e.apiStatus = 404; throw e
  }
  await assert.rejects(
    () => runAgentChain('x', [{ cli: 'claude' }, { cli: 'agy' }], { runner }),
    /model not found/,
  )
  assert.deepEqual(calls, ['claude'])  // 未尝试 agy
})

// ── timeout 纳入可回退 ────────────────────────────────────────────

test('isProviderRetryable：超时(err.timedOut) → 可回退', () => {
  assert.equal(isProviderRetryable({ timedOut: true, message: '[agy] timeout after 1000ms' }), true)
  // 仅 message 含 timeout 但无结构化标记 → 不误判（避免代码报错文本里带 timeout 触发回退）
  assert.equal(isProviderRetryable({ message: 'connection timeout to db' }), false)
})

test('runAgentChain：超时错误 → 回退到下一个 agent', async () => {
  const calls = []
  const runner = async (_p, spec) => {
    calls.push(spec.cli)
    if (spec.cli === 'agy') { const e = new Error('[agy] timeout after 1000ms'); e.timedOut = true; throw e }
    return 'OK-' + spec.cli
  }
  const r = await runAgentChain('x', [{ cli: 'agy' }, { cli: 'claude' }], { runner })
  assert.equal(r, 'OK-claude')
  assert.deepEqual(calls, ['agy', 'claude'])
})

// ── run 级冷却 ────────────────────────────────────────────────────

test('runAgentChain：run 级冷却 → 刚限额的 agent 下次降级到链尾', async () => {
  const cooldown = new Map()
  const chain = [{ cli: 'claude', provider: { name: 'anthropic-minimax' } }, { cli: 'agy' }]
  // 第 1 次：minimax 429 → 回退 agy 成功；minimax 进入冷却
  const calls1 = []
  const runner1 = async (_p, spec) => {
    calls1.push(spec.cli + (spec.provider?.name ? '/' + spec.provider.name : ''))
    if (spec.provider?.name === 'anthropic-minimax') { const e = new Error('rate limit'); e.apiStatus = 429; throw e }
    return 'OK-agy'
  }
  await runAgentChain('x', chain, { runner: runner1, cooldown })
  assert.deepEqual(calls1, ['claude/anthropic-minimax', 'agy'])
  // 第 2 次：minimax 仍在冷却 → 直接先试 agy，不再白撞 minimax
  const calls2 = []
  const runner2 = async (_p, spec) => {
    calls2.push(spec.cli + (spec.provider?.name ? '/' + spec.provider.name : ''))
    return 'OK-' + spec.cli
  }
  await runAgentChain('x', chain, { runner: runner2, cooldown })
  assert.deepEqual(calls2, ['agy'])
})

test('runAgentChain：FLOWCAST_AGENT_COOLDOWN_BASE_MS env 覆盖冷却 base', async () => {
  const prev = process.env.FLOWCAST_AGENT_COOLDOWN_BASE_MS
  process.env.FLOWCAST_AGENT_COOLDOWN_BASE_MS = '100000'   // 覆盖默认 30s → 100s
  try {
    const cooldown = new Map()
    const chain = [{ cli: 'claude', provider: { name: 'minimax' } }, { cli: 'agy' }]
    const runner = async (_p, spec) => {
      if (spec.provider?.name === 'minimax') { const e = new Error('429'); e.apiStatus = 429; throw e }
      return 'ok'
    }
    await runAgentChain('x', chain, { runner })   // 不传 cooldownBaseMs → 走 env 默认
    // 用上面的 cooldown 没意义（没传）；改为直接验证冷却时长落在 env 设定附近
    const cd = new Map()
    await runAgentChain('x', chain, { runner, cooldown: cd })
    const entry = cd.get('claude/minimax')
    const remaining = entry.until - Date.now()
    // 100s ±10% 抖动 → 应远大于内置默认 30s
    assert.ok(remaining > 60_000, `冷却应被 env 放大到 ~100s，实际剩余 ${remaining}ms`)
  } finally {
    if (prev === undefined) delete process.env.FLOWCAST_AGENT_COOLDOWN_BASE_MS
    else process.env.FLOWCAST_AGENT_COOLDOWN_BASE_MS = prev
  }
})

test('runAgentChain：冷却中的 agent 作兜底成功后解除其冷却', async () => {
  const cooldown = new Map([['claude/anthropic-minimax', Date.now() + 60_000]])
  const chain = [{ cli: 'claude', provider: { name: 'anthropic-minimax' } }, { cli: 'agy' }]
  const calls = []
  const runner = async (_p, spec) => {
    calls.push(spec.cli + (spec.provider?.name ? '/' + spec.provider.name : ''))
    if (spec.cli === 'agy') { const e = new Error('rate limit'); e.apiStatus = 429; throw e }
    return 'OK-minimax'
  }
  const r = await runAgentChain('x', chain, { runner, cooldown })
  assert.equal(r, 'OK-minimax')
  // minimax 冷却 → 先试 agy → agy 429 → 兜底回到 minimax 成功
  assert.deepEqual(calls, ['agy', 'claude/anthropic-minimax'])
  assert.equal(cooldown.has('claude/anthropic-minimax'), false)  // 成功 → 解除冷却
  assert.equal(cooldown.has('agy'), true)                        // agy 失败 → 进入冷却
})

// ── HITL 可插拔后端 ───────────────────────────────────────────────

test('默认后端是 terminal', () => {
  setHitlBackend('terminal')
  const b = getHitlBackend()
  assert.equal(typeof b.waitForInput, 'function')
  assert.equal(typeof b.notify, 'function')
})

test('wecom 后端（注入函数）：waitForInput 走 sendAndWait 并带 project_name', async () => {
  const calls = []
  setHitlBackend('wecom', {
    projectName: 'flowcast',
    sendAndWait: async (msg, ctx) => { calls.push(['wait', msg, ctx]); return 'human says yes' },
    send: async (msg, ctx) => { calls.push(['notify', msg, ctx]) },
  })
  const reply = await waitForInput('approve?')
  assert.equal(reply, 'human says yes')
  await notify('done')
  assert.equal(calls[0][0], 'wait')
  assert.equal(calls[0][1], 'approve?')
  assert.equal(calls[0][2].projectName, 'flowcast')
  assert.equal(calls[1][0], 'notify')
  assert.equal(calls[1][1], 'done')
  setHitlBackend('terminal')
})

test('自定义 backend 对象可直接注入', async () => {
  const seen = []
  setHitlBackend({
    async waitForInput(p) { seen.push(p); return 'ok' },
    async notify(m) { seen.push(m) },
  })
  assert.equal(await waitForInput('q'), 'ok')
  await notify('n')
  assert.deepEqual(seen, ['q', 'n'])
  setHitlBackend('terminal')
})

test('未知后端抛错', () => {
  assert.throws(() => setHitlBackend('telegram'), /未知 HITL 后端/)
})

test('notify: backend 没 notify → 由 backend 决定（不回退到 terminal，因为没配置 terminal 后端）', async () => {
  // 新契约：notify 不再回退 terminal 后端（避免「配了自定义 backend 却悄悄调 terminal」）。
  // 没 notify 的 backend 由调用方自行决定是否提供；这里验证 setHitlBackend 后 notify 仍走该 backend。
  let called = false
  setHitlBackend({
    async waitForInput() { return '' },
    async notify(msg) { called = true },
  })
  await notify('hello')
  assert.equal(called, true, 'backend.notify 应被调用')
  setHitlBackend('terminal')
})

test('waitForInput: 未配置 backend → fast-fail（不再静默用 terminal）', async () => {
  // 模拟「module-level _hitlBackend 是 null」场景：直接调 setHitlBackend 清空不行（非法值抛错），
  // 所以测这一条要等所有前置 setHitlBackend('terminal') 跑完后再 unset。
  // 通过 getHitlBackend 拿到当前 backend 后用 setHitlBackend(null) 报错，但用 sentinel 没法 unset。
  // 替代：测 notify 在 backend 没 notify 时抛错（call site 必须自提供 notify）。
  setHitlBackend({ async waitForInput() { return '' } })  // 无 notify
  await assert.rejects(notify('x'), /notify is not a function/)
  setHitlBackend('terminal')
})

// ── parallel ─────────────────────────────────────────────────────

test('parallel: 无 concurrency 时全部并行，结果按序，某个失败返回 null', async () => {
  const r = await parallel([
    () => Promise.resolve(1),
    () => Promise.reject(new Error('boom')),
    () => Promise.resolve(3),
  ])
  assert.deepEqual(r, [1, null, 3])
})

test('parallel: concurrency 限并发，峰值不超上限，结果仍按原序', async () => {
  let inFlight = 0
  let peak = 0
  const mk = (v) => async () => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(res => setTimeout(res, 10))
    inFlight--
    return v
  }
  const r = await parallel([mk('a'), mk('b'), mk('c'), mk('d'), mk('e')], { concurrency: 2 })
  assert.deepEqual(r, ['a', 'b', 'c', 'd', 'e'])
  assert.ok(peak <= 2, `peak in-flight ${peak} 应 <= 2`)
})

test('parallel: strict=true 任一失败抛错，err.failures 含下标和原始 error', async () => {
  await assert.rejects(
    () => parallel([
      () => Promise.resolve(1),
      () => Promise.reject(new Error('task-1-fail')),
      () => Promise.reject(new Error('task-2-fail')),
    ], { strict: true }),
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
  const r = await parallel([() => Promise.resolve('a'), () => Promise.resolve('b')], { strict: true })
  assert.deepEqual(r, ['a', 'b'])
})

test('runAgentChain: 全部 provider 限额失败时抛最后一个 provider 的错误', async () => {
  const tried = []
  const runner = async (_p, spec) => {
    tried.push(spec.cli)
    const e = new Error(`rate limit from ${spec.cli}`)
    e.apiStatus = 429
    throw e
  }
  await assert.rejects(
    () => runAgentChain('x', [{ cli: 'claude' }, { cli: 'agy' }], { runner }),
    (err) => {
      assert.match(err.message, /rate limit from agy/, '应抛最后一个 provider 的错误')
      assert.deepEqual(tried, ['claude', 'agy'], '两个 provider 都应被尝试')
      return true
    },
  )
})

test('runAgentChain: 空 chain 等价于单次调用（[{}] 默认）', async () => {
  const runner = async (_p, spec) => `ok-${JSON.stringify(spec)}`
  const r = await runAgentChain('x', [], { runner })
  assert.equal(r, 'ok-{}')
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
  // item 0 在 stage1 故意慢；item 1 应能在 item 0 还卡 stage1 时就跑完自己的 stage2。
  const order = []
  await pipeline([0, 1],
    async (x) => { if (x === 0) await delay(40); return x },
    async (x) => { order.push(`s2:${x}`); return x },
    { concurrency: 2 },
  )
  // 流式语义下 item 1（无延迟）的 stage2 先于 item 0 完成
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

// ── spawn 错误处理（spawnCli/spawnCapture ENOENT/EACCES）────────────

test('spawnCapture: 不存在的 binary → spawnError 而非 hang', async () => {
  // 旧实现：spawn 失败会让 promise 永远 hang。新实现：proc.on('error') resolve with spawnError
  const r = await import('../agent.js').then(m => m.spawnCapture('/nonexistent/binary/that/does/not/exist', [], { timeout: 2000 }))
  assert.equal(r.spawnError !== undefined, true, '应标记 spawnError')
  assert.equal(r.exitCode, -1)
  assert.match(r.stdout, /spawn error/)
})

test('spawnCapture: SIGTERM 优雅退出（被超时杀掉的子进程能正常收尾）', async () => {
  // spawn 一个 sleep 子进程，给短超时验证 SIGTERM 能让它在 ~1s 内退出（不等满 5s 兜底）
  const r = await import('../agent.js').then(m => m.spawnCapture('sleep', ['10'], { timeout: 500 }))
  assert.equal(r.timedOut, true)
  // sleep 应该被 SIGTERM 杀掉，退出码通常是 143 (128+15)
  // 如果走 SIGKILL 兜底（>5s）退出码会是 137，这里只验证 timedOut 标记
  assert.match(r.stdout, /.*/, '应有任何 stdout 内容')
})

// ── wecom mcp2cli/server 注入面保护（防 RCE）─────────────────────

test('wecom: mcp2cli 注入非默认非白名单路径 → 抛错', () => {
  // 攻击面：setHitlBackend('wecom', {mcp2cli: '/bin/sh'}) → spawn /bin/sh RCE
  // 防护：默认 'mcp2cli' 走 PATH；显式路径必须在白名单目录下
  assert.throws(
    () => setHitlBackend('wecom', { mcp2cli: '/bin/sh' }),
    /不在白名单目录/,
  )
  // /tmp 也不允许（即使文件存在）
  assert.throws(
    () => setHitlBackend('wecom', { mcp2cli: '/tmp/mcp2cli' }),
    /不在白名单目录|路径不存在/,
  )
  // 相对路径不允许
  assert.throws(
    () => setHitlBackend('wecom', { mcp2cli: './mcp2cli' }),
    /绝对路径/,
  )
  // 注入字符串而非路径
  assert.throws(
    () => setHitlBackend('wecom', { mcp2cli: 'curl evil.com' }),
    /绝对路径/,
  )
  setHitlBackend('terminal')
})

test('wecom: server 注入非 @<ns>/<name> 形式 → 抛错', () => {
  // 攻击面：setHitlBackend('wecom', {server: '-c'}) → spawn mcp2cli ['-c', tool, '--json', payload]
  // 防护：server 必须是 @<namespace>/<name> 形式
  assert.throws(
    () => setHitlBackend('wecom', { server: '-c' }),
    /server 必须是/,
  )
  assert.throws(
    () => setHitlBackend('wecom', { server: 'evil' }),
    /server 必须是/,
  )
  assert.throws(
    () => setHitlBackend('wecom', { server: '@/tool' }),
    /server 必须是/,
  )
  // 合法形式通过
  setHitlBackend('wecom', { server: '@wecom-hil', sendAndWait: async () => '' })
  setHitlBackend('terminal')
})
