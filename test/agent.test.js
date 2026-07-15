import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  spawnCapture, claudeProviderEnv, isProviderRetryable, runAgentChain, runAgent,
  setHitlBackend, getHitlBackend, waitForInput, notify, setAgentEventSink,
} from '../agent.js'

const delay = (ms) => new Promise(res => setTimeout(res, ms))

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
  const env1 = claudeProviderEnv({ name: 'deepseek', type: 'openai', apiBase: 'https://api.deepseek.com/v1', apiKey: 'sk' })
  assert.equal(env1.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/v1')
  assert.equal(env1.ANTHROPIC_AUTH_TOKEN, 'sk')
  const env2 = claudeProviderEnv({ name: 'anth', type: 'anthropic', apiBase: 'https://api.anthropic.com', apiKey: 'sk2' })
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
  assert.deepEqual(calls, ['claude'])
})

// ── timeout 纳入可回退 ────────────────────────────────────────────

test('isProviderRetryable：超时(err.timedOut) → 可回退', () => {
  assert.equal(isProviderRetryable({ timedOut: true, message: '[agy] timeout after 1000ms' }), true)
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
  const calls1 = []
  const runner1 = async (_p, spec) => {
    calls1.push(spec.cli + (spec.provider?.name ? '/' + spec.provider.name : ''))
    if (spec.provider?.name === 'anthropic-minimax') { const e = new Error('rate limit'); e.apiStatus = 429; throw e }
    return 'OK-agy'
  }
  await runAgentChain('x', chain, { runner: runner1, cooldown })
  assert.deepEqual(calls1, ['claude/anthropic-minimax', 'agy'])
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
  process.env.FLOWCAST_AGENT_COOLDOWN_BASE_MS = '100000'
  try {
    const cooldown = new Map()
    const chain = [{ cli: 'claude', provider: { name: 'minimax' } }, { cli: 'agy' }]
    const runner = async (_p, spec) => {
      if (spec.provider?.name === 'minimax') { const e = new Error('429'); e.apiStatus = 429; throw e }
      return 'ok'
    }
    const cd = new Map()
    await runAgentChain('x', chain, { runner, cooldown: cd })
    const entry = cd.get('claude/minimax')
    const remaining = entry.until - Date.now()
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
  assert.deepEqual(calls, ['agy', 'claude/anthropic-minimax'])
  assert.equal(cooldown.has('claude/anthropic-minimax'), false)
  assert.equal(cooldown.has('agy'), true)
})

// ── recursive extras（v0.6 替代原 recursive adapter 测试）─────────

// 假 recursive 二进制：按 FAKE_MODE 控制输出/退出码，并按 --transcript-out 写 transcript。
// agentproc 的 recursive executor 用 --json --stream run <msg> 启动，
// 让 fake bin 简单忽略其他 flag，只看 FAKE_MODE。
const FAKE_RECURSIVE_BIN = `#!/bin/sh
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

function makeFakeRecursiveBin() {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-recbin-'))
  const bin = join(dir, 'recursive')
  writeFileSync(bin, FAKE_RECURSIVE_BIN)
  chmodSync(bin, 0o755)
  return { dir, bin }
}

test('recursive（via runAgent + fake bin）：finishReason + transcriptMessages', async () => {
  // v0.6: 通过 runAgent + 替换 PATH 让 agentproc 找到 fake recursive 二进制
  // transcriptOut 必须是相对路径（flowcast 路径安全约束），用 cwd 切换到 dir 后传入相对名
  const { dir } = makeFakeRecursiveBin()
  const prevPath = process.env.PATH
  const prevCwd = process.cwd()
  process.env.PATH = `${dir}:${prevPath || ''}`
  process.chdir(dir)
  try {
    const out = await runAgent('do something', {
      cli: 'recursive',
      cwd: dir,
      transcriptOut: 't.json',
      timeout: 5_000,
    })
    assert.equal(out._meta.cli, 'recursive')
    assert.equal(out._meta.finishReason, 'Done')
    assert.equal(out._meta.budgetExceeded, false)
    assert.equal(out._meta.panicked, false)
    assert.equal(out._meta.transcriptMessages, 3)
  } finally {
    process.chdir(prevCwd)
    process.env.PATH = prevPath
    rmSync(dir, { recursive: true, force: true })
  }
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

test('wecom 后端（注入函数）：notify 带 imagePaths 时透传给 send ctx', async () => {
  const calls = []
  setHitlBackend('wecom', {
    projectName: 'test-proj',
    sendAndWait: async () => '',
    send: async (msg, ctx) => { calls.push({ msg, ctx }) },
  })
  await notify('请扫码登录', { imagePaths: ['/tmp/qr.png'] })
  assert.equal(calls[0].msg, '请扫码登录')
  assert.deepEqual(calls[0].ctx.imagePaths, ['/tmp/qr.png'])
  setHitlBackend('terminal')
})

test('notify 不带 imagePaths 时 opts 默认为空对象（向后兼容）', async () => {
  const calls = []
  setHitlBackend('wecom', {
    projectName: 'test-proj',
    sendAndWait: async () => '',
    send: async (msg, ctx) => { calls.push({ msg, ctx }) },
  })
  await notify('hello')
  assert.equal(calls[0].msg, 'hello')
  assert.equal(calls[0].ctx.imagePaths, undefined)
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

test('notify: backend 没 notify → 由 backend 决定', async () => {
  let called = false
  setHitlBackend({
    async waitForInput() { return '' },
    async notify(msg) { called = true },
  })
  await notify('hello')
  assert.equal(called, true, 'backend.notify 应被调用')
  setHitlBackend('terminal')
})

test('waitForInput: backend 没 notify → notify 抛错', async () => {
  setHitlBackend({ async waitForInput() { return '' } })
  await assert.rejects(notify('x'), /notify is not a function/)
  setHitlBackend('terminal')
})

// ── runAgent dry-run（v0.6 新增）───────────────────────────────────

test('runAgent dry-run：所有 CLI 走 fake runner，不调真实二进制', async () => {
  const prevDry = process.env.FLOWCAST_DRY_RUN
  process.env.FLOWCAST_DRY_RUN = '1'
  try {
    for (const cli of ['claude', 'agy', 'codex', 'cursor', 'gemini', 'aider', 'recursive', 'pi', 'opencode']) {
      const out = await runAgent('hello', { cli, cwd: '/tmp' })
      assert.equal(out._meta.dryRun, true, `${cli} 应走 dry-run 路径`)
      assert.match(String(out), /dry-run/)
    }
  } finally {
    if (prevDry === undefined) delete process.env.FLOWCAST_DRY_RUN
    else process.env.FLOWCAST_DRY_RUN = prevDry
  }
})

// parallel / pipeline 测试已迁移到 test/concurrency.test.js