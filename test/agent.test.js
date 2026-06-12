import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  recursive, spawnCapture, claudeProviderEnv, isProviderRetryable, runAgentChain,
  setHitlBackend, getHitlBackend, waitForInput, notify, parallel,
} from '../agent.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'flowx-recbin-'))
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

test('claudeProviderEnv：非 anthropic 协议 fail-fast', () => {
  assert.throws(
    () => claudeProviderEnv({ name: 'deepseek', type: 'openai', apiBase: 'x', apiKey: 'y' }),
    /只支持 anthropic 协议/
  )
})

// ── provider 回退判定 ─────────────────────────────────────────────

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
    projectName: 'flowx',
    sendAndWait: async (msg, ctx) => { calls.push(['wait', msg, ctx]); return 'human says yes' },
    send: async (msg, ctx) => { calls.push(['notify', msg, ctx]) },
  })
  const reply = await waitForInput('approve?')
  assert.equal(reply, 'human says yes')
  await notify('done')
  assert.equal(calls[0][0], 'wait')
  assert.equal(calls[0][1], 'approve?')
  assert.equal(calls[0][2].projectName, 'flowx')
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

test('notify 在后端无 notify 时回退终端（不抛）', async () => {
  setHitlBackend({ async waitForInput() { return '' } }) // 无 notify
  await assert.doesNotReject(notify('fallback message'))
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
