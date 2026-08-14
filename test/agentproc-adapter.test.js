import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CLI_TO_EXECUTOR, cliToExecutorName, buildAgentProcProfile,
  buildAgentProcOptions, resultToAgentResult, KNOWN_EXECUTORS,
} from '../executor/agentproc-adapter.js'
import { ConfigError, TimeoutError, SpawnError, FlowcastError } from '../errors.js'
import { agentMeta, agentText } from '../helpers.js'

// ── cliToExecutorName ──────────────────────────────────────────────────

test('cliToExecutorName：flowcast 名 → agentproc executor 名', () => {
  assert.equal(cliToExecutorName('claude'), 'claude-code')
  assert.equal(cliToExecutorName('cursor'), 'cursor')
  assert.equal(cliToExecutorName('agent'), 'cursor')        // 历史别名
  assert.equal(cliToExecutorName('gemini'), 'gemini-cli')
  assert.equal(cliToExecutorName('agy'), 'agy')
  assert.equal(cliToExecutorName('aider'), 'aider')
  assert.equal(cliToExecutorName('pi'), 'pi')
  assert.equal(cliToExecutorName('opencode'), 'opencode')
})

test('cliToExecutorName：dsh → dsh（agentproc >= 0.11 原生，0.10.x 兼容注入）', () => {
  assert.equal(cliToExecutorName('dsh'), 'dsh')
})

test('cliToExecutorName：recursive → null（agentproc SDK 不收录，走 flowcast 路径）', () => {
  assert.equal(cliToExecutorName('recursive'), null)
})

test('cliToExecutorName：未知 CLI 抛 ConfigError', () => {
  assert.throws(() => cliToExecutorName('totally-unknown'), /未知执行器/)
})

test('CLI_TO_EXECUTOR：包含 15 个 flowcast 支持的 CLI', () => {
  // flowcast 历史上支持的 7 个 + agentproc 新接入的 7 个（去除 recursive）+ dsh
  for (const cli of ['claude', 'cursor', 'agent', 'gemini', 'codex', 'agy', 'aider', 'recursive',
                     'pi', 'opencode', 'kimi-code', 'deepseek', 'qwen-code', 'codebuddy', 'dsh']) {
    assert.ok(cli in CLI_TO_EXECUTOR, `${cli} 应在映射表`)
  }
})

// ── buildAgentProcProfile ──────────────────────────────────────────────

test('buildAgentProcProfile：基础字段', () => {
  const p = buildAgentProcProfile({ cli: 'claude', cwd: '/tmp' })
  assert.equal(p.executor, 'claude-code')
  assert.equal(p.cwd, '/tmp')
  assert.equal(p.streaming, true)
  assert.equal(p.permission, false)
  assert.deepEqual(p.env, {})
})

test('buildAgentProcProfile：dsh 默认注入 DSH_PERMISSION_MODE（无人值守）', () => {
  const p = buildAgentProcProfile({ cli: 'dsh' })
  assert.equal(p.executor, 'dsh')
  assert.equal(p.env.DSH_PERMISSION_MODE, 'danger-full-access')
  assert.equal(p.timeout_secs, 1800) // 1_800_000 ms，与 recursive 同级
})

test('buildAgentProcProfile：dsh 显式 DEEPSEEK_API_KEY 优先于进程 env 透传', () => {
  const saved = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'sk-from-shell'
  try {
    const explicit = buildAgentProcProfile({ cli: 'dsh', env: { DEEPSEEK_API_KEY: 'sk-explicit' } })
    assert.equal(explicit.env.DEEPSEEK_API_KEY, 'sk-explicit')
    const passthrough = buildAgentProcProfile({ cli: 'dsh' })
    assert.equal(passthrough.env.DEEPSEEK_API_KEY, 'sk-from-shell')
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = saved
  }
})

test('buildAgentProcProfile：dsh 显式 env 不被默认值覆盖', () => {
  const p = buildAgentProcProfile({ cli: 'dsh', env: { DSH_PERMISSION_MODE: 'read-only' } })
  assert.equal(p.env.DSH_PERMISSION_MODE, 'read-only')
})

test('ensureDshExecutor：agentproc EXECUTORS 注册表里有 dsh（原生或注入）', async () => {
  const agentproc = (await import('agentproc')).default
  assert.ok(agentproc.EXECUTORS.dsh, 'EXECUTORS.dsh 应存在（SDK >= 0.11 原生 / 0.10.x 注入）')
  assert.equal(agentproc.EXECUTORS.dsh.cliName, 'dsh')
  assert.equal(agentproc.EXECUTORS.dsh.plain, true)
  assert.deepEqual(agentproc.EXECUTORS.dsh.buildArgs('hi', '', {}), ['dsh', '--profile', 'headless', 'hi'])
  assert.ok(KNOWN_EXECUTORS.includes('dsh'), 'KNOWN_EXECUTORS 应包含 dsh')
})

test('buildAgentProcProfile：env + envAllowlist + extraEnv', () => {
  const p = buildAgentProcProfile({
    cli: 'claude',
    env: { ANTHROPIC_API_KEY: 'sk-x' },
    envAllowlist: ['ANTHROPIC_API_KEY'],
    extraEnv: { MY_OVERRIDE: '1' },
  })
  assert.deepEqual(p.env, { ANTHROPIC_API_KEY: 'sk-x', MY_OVERRIDE: '1' })
  assert.deepEqual(p.env_allowlist, ['ANTHROPIC_API_KEY'])
})

test('buildAgentProcProfile：timeout 转 timeout_secs（向上取整）', () => {
  assert.equal(buildAgentProcProfile({ cli: 'claude', timeout: 1000 }).timeout_secs, 1)
  assert.equal(buildAgentProcProfile({ cli: 'claude', timeout: 1500 }).timeout_secs, 2)  // ceil
  assert.equal(buildAgentProcProfile({ cli: 'claude' }).timeout_secs, 300)  // 默认 5min
})

test('buildAgentProcProfile：不同 CLI 有不同默认 timeout', () => {
  assert.equal(buildAgentProcProfile({ cli: 'claude' }).timeout_secs, 300)
  assert.equal(buildAgentProcProfile({ cli: 'aider' }).timeout_secs, 600)
  assert.equal(buildAgentProcProfile({ cli: 'recursive' }), null)  // 走 flowcast 路径
})

test('buildAgentProcProfile：recursive 返回 null（flowcast 自处理）', () => {
  assert.equal(buildAgentProcProfile({ cli: 'recursive' }), null)
})

// ── buildAgentProcOptions ──────────────────────────────────────────────

test('buildAgentProcOptions：必填 message', () => {
  const opts = buildAgentProcOptions('hello')
  assert.equal(opts.message, 'hello')
  assert.equal(opts.sessionId, '')
  assert.equal(opts.sessionName, 'default')
})

test('buildAgentProcOptions：callbacks 透传', () => {
  const onPartial = () => {}
  const onError = () => {}
  const opts = buildAgentProcOptions('hi', { onPartial, onError, sessionId: 'sid-123' })
  assert.equal(opts.onPartial, onPartial)
  assert.equal(opts.onError, onError)
  assert.equal(opts.sessionId, 'sid-123')
})

// ── resultToAgentResult ────────────────────────────────────────────────

test('resultToAgentResult：成功路径 → makeAgentResult（保持 String & {_meta} 契约）', () => {
  const r = resultToAgentResult({
    reply: 'hello world',
    sessionId: 'sid-1',
    exitCode: 0,
    timedOut: false,
    usage: { input_tokens: 10, output_tokens: 5 },
  }, 'claude', 'claude-code')
  assert.equal(agentText(r), 'hello world')
  const meta = agentMeta(r)
  assert.equal(meta.cli, 'claude')
  assert.equal(meta.executor, 'claude-code')
  assert.equal(meta.sessionId, 'sid-1')
  assert.equal(meta.exitCode, 0)
  assert.equal(meta.timedOut, false)
  assert.equal(meta.inputTokens, 10)
  assert.equal(meta.outputTokens, 5)
  assert.deepEqual(meta.usage, { input_tokens: 10, output_tokens: 5 })
})

test('resultToAgentResult：usage 含 cache + reasoning 字段 → 透传', () => {
  const r = resultToAgentResult({
    reply: 'x',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 5,
      reasoning_tokens: 12,
      duration_ms: 1500,
      cost_usd: 0.012,
    },
    exitCode: 0,
    timedOut: false,
  }, 'claude', 'claude-code')
  const meta = agentMeta(r)
  assert.equal(meta.usage.cache_read_input_tokens, 80)
  assert.equal(meta.usage.cache_creation_input_tokens, 5)
  assert.equal(meta.usage.reasoning_tokens, 12)
  assert.equal(meta.usage.duration_ms, 1500)
  assert.equal(meta.usage.cost_usd, 0.012)
})

test('resultToAgentResult：timedOut=true → 抛 TimeoutError', () => {
  assert.throws(
    () => resultToAgentResult({ error: 'timeout after 5000ms', timedOut: true, exitCode: 124 }, 'claude', 'claude-code'),
    (err) => err instanceof TimeoutError && err.timedOut === true,
  )
})

test('resultToAgentResult：CLI 不存在 → 抛 SpawnError', () => {
  assert.throws(
    () => resultToAgentResult({ error: 'claude CLI not found. Install hint...', exitCode: 1 }, 'claude', 'claude-code'),
    (err) => err instanceof SpawnError,
  )
})

test('resultToAgentResult：通用 error → 抛 FlowcastError（AGENT_FAIL）', () => {
  assert.throws(
    () => resultToAgentResult({ error: 'unexpected upstream', exitCode: 1 }, 'claude', 'claude-code'),
    (err) => err instanceof FlowcastError && err.code === 'AGENT_FAIL',
  )
})

test('resultToAgentResult：null / undefined 输入 → 抛 AGENTPROC_INVALID_RESULT', () => {
  assert.throws(
    () => resultToAgentResult(null, 'claude', 'claude-code'),
    (err) => err instanceof FlowcastError && err.code === 'AGENTPROC_INVALID_RESULT',
  )
})

// ── KNOWN_EXECUTORS ────────────────────────────────────────────────────

test('KNOWN_EXECUTORS：包含 agentproc SDK 当前支持的全部 executor', () => {
  assert.ok(Array.isArray(KNOWN_EXECUTORS))
  assert.ok(KNOWN_EXECUTORS.includes('claude-code'))
  assert.ok(KNOWN_EXECUTORS.includes('recursive') === false)  // SDK 不收录
  assert.ok(KNOWN_EXECUTORS.length >= 12)
})