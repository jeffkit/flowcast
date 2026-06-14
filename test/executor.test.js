import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXECUTORS, getExecutor, loadAgents, resolveAgent, registerExecutor } from '../executor.js'

const PROVIDERS = {
  deepseek: { type: 'openai', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', apiKey: '${DS_KEY}' },
}
const ENV = { DS_KEY: 'sk-xyz' }

// ── 能力分层 ─────────────────────────────────────────────────────

test('getExecutor: BYO 执行器 acceptsProvider=true', () => {
  assert.equal(getExecutor('recursive').acceptsProvider, true)
  assert.equal(getExecutor('aider').acceptsProvider, true)
  assert.equal(getExecutor('claude').acceptsProvider, true)
})

test('getExecutor: 锁定型执行器 acceptsProvider=false', () => {
  assert.equal(getExecutor('cursor').acceptsProvider, false)
  assert.equal(getExecutor('gemini').acceptsProvider, false)
  assert.equal(getExecutor('codex').acceptsProvider, false)
})

test('getExecutor: 未知执行器报错', () => {
  assert.throws(() => getExecutor('nope'), /未知执行器 'nope'/)
})

test('EXECUTORS: 注册表包含全部内置 adapter', () => {
  const builtins = ['agent', 'agy', 'aider', 'claude', 'codex', 'cursor', 'gemini', 'recursive']
  for (const name of builtins) assert.ok(name in EXECUTORS, `内置 adapter ${name} 应在注册表`)
})

test('EXECUTORS: agent/agy/codex 为锁定型（不接受外部 provider）', () => {
  for (const name of ['agent', 'agy', 'codex']) {
    assert.equal(getExecutor(name).acceptsProvider, false, `${name} 应为锁定型`)
  }
})

test('resolveAgent: 锁定型执行器配 provider → fail-fast', () => {
  const agents = { 'agy-ds': { executor: 'agy', provider: 'deepseek' } }
  assert.throws(
    () => resolveAgent('agy-ds', agents, { providers: PROVIDERS, env: ENV }),
    /不接受外部 provider/,
  )
})

// ── resolveAgent：BYO 执行器绑定 provider ────────────────────────

test('resolveAgent: recursive + provider → RECURSIVE_* env', () => {
  const agents = { 'rec-ds': { executor: 'recursive', provider: 'deepseek', maxSteps: 60 } }
  const r = resolveAgent('rec-ds', agents, { providers: PROVIDERS, env: ENV })
  assert.equal(r.executor, 'recursive')
  assert.equal(typeof r.run, 'function')
  assert.equal(r.opts.maxSteps, 60)
  assert.equal(r.opts.env.RECURSIVE_API_BASE, 'https://api.deepseek.com/v1')
  assert.equal(r.opts.env.RECURSIVE_API_KEY, 'sk-xyz')
  assert.equal(r.opts.env.RECURSIVE_MODEL, 'deepseek-v4-pro')
})

test('resolveAgent: claude + provider → ANTHROPIC_* env + model 透出', () => {
  // Claude Code CLI 用 ANTHROPIC_AUTH_TOKEN（不是 ANTHROPIC_API_KEY）。
  // 统一翻译器后这条路径走 agent.js 的 claudeProviderEnv，env 变量名以那里为准。
  const agents = { 'cl-ds': { executor: 'claude', provider: 'deepseek' } }
  const r = resolveAgent('cl-ds', agents, { providers: PROVIDERS, env: ENV })
  assert.equal(r.opts.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/v1')
  assert.equal(r.opts.env.ANTHROPIC_AUTH_TOKEN, 'sk-xyz')
  assert.equal(r.opts.model, 'deepseek-v4-pro')
})

test('resolveAgent: profile 显式 model 优先于 provider 默认 model', () => {
  const agents = { 'cl-ds': { executor: 'claude', provider: 'deepseek', model: 'claude-sonnet-4' } }
  const r = resolveAgent('cl-ds', agents, { providers: PROVIDERS, env: ENV })
  assert.equal(r.opts.model, 'claude-sonnet-4')
})

// ── resolveAgent：锁定型执行器拒绝 provider ──────────────────────

test('resolveAgent: 给 cursor 配 provider → fail-fast', () => {
  const agents = { bad: { executor: 'cursor', provider: 'deepseek' } }
  assert.throws(
    () => resolveAgent('bad', agents, { providers: PROVIDERS, env: ENV }),
    /'cursor' 不接受外部 provider/,
  )
})

test('resolveAgent: cursor 仅用自带 model，合法', () => {
  const agents = { 'cur': { executor: 'cursor', model: 'auto' } }
  const r = resolveAgent('cur', agents)
  assert.equal(r.executor, 'cursor')
  assert.equal(r.opts.model, 'auto')
  assert.equal(r.opts.env, undefined)
})

// ── resolveAgent：错误路径 ───────────────────────────────────────

test('resolveAgent: 未知 agent 报错并列出已定义', () => {
  assert.throws(() => resolveAgent('ghost', { a: { executor: 'cursor' } }), /未知 agent 'ghost'.*已定义：a/s)
})

test('resolveAgent: 缺 executor 字段报错', () => {
  assert.throws(() => resolveAgent('x', { x: { provider: 'deepseek' } }), /缺少 executor/)
})

// ── loadAgents（多层合并）────────────────────────────────────────

test('loadAgents: 项目级覆盖机器级', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flowcast-ah-'))
  const proj = mkdtempSync(join(tmpdir(), 'flowcast-ap-'))
  try {
    mkdirSync(join(home, '.flowx'), { recursive: true })
    mkdirSync(join(proj, '.flowx'), { recursive: true })
    writeFileSync(join(home, '.flowx', 'agents.json'), JSON.stringify({
      agents: { a: { executor: 'cursor' }, b: { executor: 'recursive', provider: 'x' } },
    }))
    writeFileSync(join(proj, '.flowx', 'agents.json'), JSON.stringify({
      agents: { b: { executor: 'claude' } },
    }))
    const merged = await loadAgents({ dirs: [join(home, '.flowx'), join(proj, '.flowx')] })
    assert.equal(merged.a.executor, 'cursor')   // 仅机器级
    assert.equal(merged.b.executor, 'claude')   // 项目级覆盖
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})

// ── registerExecutor ─────────────────────────────────────────────

test('registerExecutor: 注册后 getExecutor 能查到，acceptsProvider 按 applyProvider 派生', () => {
  const myRun = async () => 'my-result'
  registerExecutor('my-cli', myRun)
  try {
    const ex = getExecutor('my-cli')
    assert.equal(ex.name, 'my-cli')
    assert.equal(ex.run, myRun)
    assert.equal(ex.acceptsProvider, false)
  } finally {
    delete EXECUTORS['my-cli']
  }
})

test('registerExecutor: 带 applyProvider 则 acceptsProvider=true，resolveAgent 能用', () => {
  const myRun = async (prompt, { model } = {}) => `result-${model}`
  const myApply = (bundle) => ({ model: bundle.model ?? 'default' })
  registerExecutor('my-byo', myRun, { applyProvider: myApply })
  try {
    assert.equal(getExecutor('my-byo').acceptsProvider, true)
    const agents = { dev: { executor: 'my-byo', provider: 'deepseek' } }
    const r = resolveAgent('dev', agents, { providers: PROVIDERS, env: ENV })
    assert.equal(r.executor, 'my-byo')
    assert.equal(r.opts.model, 'deepseek-v4-pro')
  } finally {
    delete EXECUTORS['my-byo']
  }
})

test('registerExecutor: run 非函数抛 TypeError', () => {
  assert.throws(() => registerExecutor('bad', 'not-a-fn'), /TypeError|run 必须是函数/)
})

// ── extraArgs / 配置字段白名单（防 LLM 注入任意文件路径）──────────

test('resolveAgent: 透传字段必须在白名单内（systemPromptFile/workspace 等被丢弃）', () => {
  // 攻击面：agents.json 写 `systemPromptFile: "/etc/shadow"` → 传给 recursive → 任意文件读
  // 防护：白名单 SAFE_OPTS_KEYS 之外的字段被静默丢弃
  const agents = {
    'evil-rec': {
      executor: 'recursive',
      systemPromptFile: '/etc/shadow',   // 不在白名单
      workspace: '/etc',                  // 不在白名单（之前能透传）
      maxSteps: 50,                       // 在白名单
    },
  }
  const r = resolveAgent('evil-rec', agents, { providers: PROVIDERS, env: ENV })
  // 透传给 recursive 的 opts 必须不含危险字段
  assert.equal(r.opts.systemPromptFile, undefined, 'systemPromptFile 应被丢弃')
  assert.equal(r.opts.workspace, undefined, 'workspace 应被丢弃')
  assert.equal(r.opts.maxSteps, 50, '白名单字段应保留')
})

test('resolveAgent: extraArgs 元素级白名单——只允许已知安全 flag', () => {
  const agents = {
    'cl-injected': {
      executor: 'claude',
      extraArgs: [
        '--model', 'sonnet',                 // 合法
        '--output-format', 'json',            // 合法
        '--system-prompt-file', '/etc/shadow', // 非法——claude 不允许此 flag
        '--upload-file', '/etc/passwd',       // 非法
        '--exec', 'rm -rf /',                  // 非法
      ],
    },
  }
  const r = resolveAgent('cl-injected', agents, { providers: PROVIDERS, env: ENV })
  // 应该只保留白名单内的 flag
  assert.deepEqual(r.opts.extraArgs, ['--model', 'sonnet', '--output-format', 'json'])
})

test('resolveAgent: extraArgs 锁定型执行器（cursor/gemini/codex/agy）拒绝任何 flag', () => {
  // 锁定型不接 extraArgs——用户不能往这些 CLI 塞 flag
  for (const ex of ['cursor', 'gemini', 'codex', 'agy']) {
    const agents = { [`bad-${ex}`]: { executor: ex, extraArgs: ['--model', 'x'] } }
    const r = resolveAgent(`bad-${ex}`, agents, { providers: PROVIDERS, env: ENV })
    assert.deepEqual(r.opts.extraArgs, [], `${ex} 不应保留 extraArgs`)
  }
})

test('resolveAgent: extraArgs 未知执行器 → 拒绝所有 flag（保守）', () => {
  // 通过 registerExecutor 注册的未知 executor，extraArgs 应被空集过滤
  registerExecutor('my-cli', async () => 'ok')
  const agents = { 'c1': { executor: 'my-cli', extraArgs: ['--flag', 'val'] } }
  const r = resolveAgent('c1', agents, { providers: PROVIDERS, env: ENV })
  assert.deepEqual(r.opts.extraArgs, [], '未知 executor 应丢弃 extraArgs')
})

test('sanitizeExtraArgs: --flag=value 形式正常处理', async () => {
  // 边界：值在同一个 argv 元素里（= 形式）应被识别
  const { sanitizeExtraArgs } = await import('../executor.js')
  const out = sanitizeExtraArgs('claude', ['--model=sonnet', '--output-format=json', '--system-prompt-file=/etc/shadow'])
  assert.deepEqual(out, ['--model=sonnet', '--output-format=json'])
})
