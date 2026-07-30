import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectAuth,
  scanAgents,
  validateAgentsConfig,
  validateProvidersConfig,
  BYO_LLM_CLIS,
} from '../scan.js'
import { buildConfigFromScan } from '../bin/init.js'

// ── detectAuth ──────────────────────────────────────────────────────────

test('detectAuth: claude 凭证文件存在 → authed', () => {
  const fakeExists = (p) => p === '/h/.claude/.credentials.json'
  const r = detectAuth('claude', { home: '/h', exists: fakeExists, stat: () => ({ isFile: () => true }) })
  assert.equal(r.authed, true)
  assert.match(r.detail, /\.credentials\.json/)
})

test('detectAuth: claude 走 env ANTHROPIC_API_KEY', () => {
  const r = detectAuth('claude', { home: '/h', env: { ANTHROPIC_API_KEY: 'x' }, exists: () => false })
  assert.equal(r.authed, true)
})

test('detectAuth: claude 无任何凭证 → 未登录', () => {
  const r = detectAuth('claude', { home: '/h', env: {}, exists: () => false })
  assert.equal(r.authed, false)
})

test('detectAuth: BYO-LLM CLI（aider/recursive）凭证不确定 → null', () => {
  assert.equal(detectAuth('aider', { env: {} }).authed, null)
  assert.equal(detectAuth('recursive', { env: {} }).authed, null)
})

test('detectAuth: cursor 看 ~/.cursor/ 目录', () => {
  const r1 = detectAuth('cursor', { home: '/h', exists: (p) => p === '/h/.cursor' })
  assert.equal(r1.authed, true)
  const r2 = detectAuth('cursor', { home: '/h', exists: () => false })
  assert.equal(r2.authed, false)
})

// ── scanAgents（注入 which） ──────────────────────────────────────────────

test('scanAgents: 注入 which 控制 installed，别名 agent 被去重', async () => {
  const which = (cli) => (cli === 'cursor' || cli === 'agent' ? '/usr/bin/' + cli : null)
  const r = await scanAgents({ which, env: {}, home: '/h', exists: () => false })
  const cliNames = r.map(a => a.cli)
  // agent 是 cursor 的别名，应被跳过
  assert.ok(!cliNames.includes('agent'), 'agent 别名不应出现')
  const cursor = r.find(a => a.cli === 'cursor')
  assert.equal(cursor.installed, true)
  assert.equal(cursor.path, '/usr/bin/cursor')
  assert.equal(cursor.acceptsProvider, false)  // cursor 是锁定型
})

test('scanAgents: BYO-LLM CLI（claude）的 acceptsProvider=true', async () => {
  const which = (cli) => cli === 'claude' ? '/usr/bin/claude' : null
  const r = await scanAgents({ which, env: { ANTHROPIC_API_KEY: 'x' }, home: '/h', exists: () => false })
  const claude = r.find(a => a.cli === 'claude')
  assert.equal(claude.acceptsProvider, true)
  assert.equal(claude.ready, true)
})

test('scanAgents: 已装但凭证未登录 → ready=false', async () => {
  const which = () => '/usr/bin/claude'  // 假装全部已装
  const r = await scanAgents({ which, env: {}, home: '/h', exists: () => false })
  const claude = r.find(a => a.cli === 'claude')
  assert.equal(claude.installed, true)
  assert.equal(claude.authed, false)
  assert.equal(claude.ready, false)
})

// ── validateAgentsConfig ────────────────────────────────────────────────

test('validateAgentsConfig: 合法配置无问题', () => {
  const agents = { ok: { executor: 'claude' } }
  assert.deepEqual(validateAgentsConfig(agents, {}), [])
})

test('validateAgentsConfig: 未知 executor 报错', () => {
  const agents = { bad: { executor: 'no-such-cli' } }
  const r = validateAgentsConfig(agents, {})
  assert.equal(r.length, 1)
  assert.equal(r[0].agent, 'bad')
  assert.match(r[0].problems[0], /不在已知列表/)
})

test('validateAgentsConfig: 引用不存在的 provider 报错', () => {
  const agents = { x: { executor: 'claude', provider: 'missing' } }
  const r = validateAgentsConfig(agents, { other: {} })
  assert.match(r[0].problems[0], /provider 'missing' 未在 providers/)
})

test('validateAgentsConfig: 缺 executor 字段', () => {
  const r = validateAgentsConfig({ x: { model: 'm' } }, {})
  assert.match(r[0].problems[0], /缺少 executor/)
})

// ── validateProvidersConfig ─────────────────────────────────────────────

test('validateProvidersConfig: ${ENV} 已设置 → 无问题', () => {
  const providers = { p: { apiKey: '${MY_KEY}' } }
  assert.deepEqual(validateProvidersConfig(providers, { MY_KEY: 'abc' }), [])
})

test('validateProvidersConfig: ${ENV} 未设置 → 报错', () => {
  const providers = { p: { apiKey: '${MISSING}' } }
  const r = validateProvidersConfig(providers, {})
  assert.equal(r.length, 1)
  assert.match(r[0].problems[0], /MISSING 未设置/)
})

// ── buildConfigFromScan ─────────────────────────────────────────────────

test('buildConfigFromScan: 锁定型 CLI 不带 provider', () => {
  const scan = { agents: [{ cli: 'cursor', acceptsProvider: false }] }
  const { agents, providers } = buildConfigFromScan(scan, { clis: ['cursor'], defaultCli: 'cursor' })
  assert.deepEqual(agents['cursor-default'], { executor: 'cursor', model: 'auto' })
  assert.deepEqual(providers, {})
})

test('buildConfigFromScan: BYO-LLM CLI 带 provider，apiKey 为 ${ENV} 形式', () => {
  const scan = { agents: [{ cli: 'claude', acceptsProvider: true }] }
  const sel = {
    clis: ['claude'],
    defaultCli: 'claude',
    providers: { claude: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' } },
  }
  const { agents, providers } = buildConfigFromScan(scan, sel)
  assert.equal(agents.claude.provider, 'claude-default')
  assert.equal(providers['claude-default'].apiKey, '${ANTHROPIC_API_KEY}')
  assert.equal(providers['claude-default'].type, 'anthropic')
})

test('buildConfigFromScan: BYO-LLM CLI 未给 provider → profile 不挂 provider', () => {
  const scan = { agents: [{ cli: 'claude', acceptsProvider: true }] }
  const { agents, providers } = buildConfigFromScan(scan, { clis: ['claude'], defaultCli: 'claude' })
  assert.equal(agents.claude.provider, undefined)
  assert.deepEqual(providers, {})
})

// ── 常量 ────────────────────────────────────────────────────────────────

test('BYO_LLM_CLIS: claude/aider/recursive 在列', () => {
  assert.ok(BYO_LLM_CLIS.has('claude'))
  assert.ok(BYO_LLM_CLIS.has('aider'))
  assert.ok(BYO_LLM_CLIS.has('recursive'))
  assert.ok(!BYO_LLM_CLIS.has('cursor'))
})

// ── doctor: 未引用 provider 的缺 env 降级为 ⚠️ ─────────────────────────

test('doctor: 未被 agent 引用的 provider 缺 env → ⚠️ 提示，不计入退出码', async () => {
  const { runDoctor } = await import('../bin/doctor.js')
  // p-used 被某 agent 引用且缺 env → 致命 ✗；p-idle 未被引用且缺 env → ⚠️
  const scan = {
    agents: [{
      cli: 'cursor', executor: 'cursor', acceptsProvider: false,
      installed: true, authed: true, ready: true, authDetail: 'ok',
    }],
    config: {
      agents: { 'cursor-default': { executor: 'cursor', provider: 'p-used' } },
      providers: { 'p-used': { apiKey: '${MISSING_USED}' }, 'p-idle': { apiKey: '${MISSING_IDLE}' } },
      agentProblems: [],
      providerProblems: [
        { provider: 'p-used', problems: ['环境变量 MISSING_USED 未设置'] },
        { provider: 'p-idle', problems: ['环境变量 MISSING_IDLE 未设置'] },
      ],
    },
    summary: { totalClis: 1, installedClis: 1, readyClis: 1, hasUsableAgent: true, configOk: false },
    flowcastResolvable: { ok: true },
  }
  const lines = []
  const out = { write: (s) => lines.push(s) }
  const code = await runDoctor(['--repo', '.'], { scan, out })
  const text = lines.join('')

  // p-used 被引用 → ✗ 致命
  assert.match(text, /✗ provider 'p-used' 配置/)
  assert.match(text, /✗ provider 'p-used'[\s\S]*设置缺失的环境变量/)
  // p-idle 未引用 → ⚠️ 提示
  assert.match(text, /⚠ provider 'p-idle' 配置/)
  assert.match(text, /未被任何 agent 引用/)
  // 有致命项 → 退出码 1
  assert.equal(code, 1)
})

test('doctor: 全部缺 env 的 provider 都未被引用 → 退出码 0', async () => {
  const { runDoctor } = await import('../bin/doctor.js')
  const scan = {
    agents: [{
      cli: 'cursor', executor: 'cursor', acceptsProvider: false,
      installed: true, authed: true, ready: true, authDetail: 'ok',
    }],
    config: {
      agents: { 'cursor-default': { executor: 'cursor' } },
      providers: { 'p-idle': { apiKey: '${MISSING}' } },
      agentProblems: [],
      providerProblems: [
        { provider: 'p-idle', problems: ['环境变量 MISSING 未设置'] },
      ],
    },
    summary: { totalClis: 1, installedClis: 1, readyClis: 1, hasUsableAgent: true, configOk: false },
    flowcastResolvable: { ok: true },
  }
  const lines = []
  const out = { write: (s) => lines.push(s) }
  const code = await runDoctor(['--repo', '.'], { scan, out })
  assert.match(lines.join(''), /环境就绪/)
  assert.equal(code, 0)
})
