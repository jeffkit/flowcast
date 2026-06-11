import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXECUTORS, getExecutor, loadAgents, resolveAgent } from '../executor.js'

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

test('EXECUTORS: 注册表覆盖现有 6 个 adapter', () => {
  assert.deepEqual(Object.keys(EXECUTORS).sort(), ['aider', 'claude', 'codex', 'cursor', 'gemini', 'recursive'])
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
  const agents = { 'cl-ds': { executor: 'claude', provider: 'deepseek' } }
  const r = resolveAgent('cl-ds', agents, { providers: PROVIDERS, env: ENV })
  assert.equal(r.opts.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/v1')
  assert.equal(r.opts.env.ANTHROPIC_API_KEY, 'sk-xyz')
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
  const home = mkdtempSync(join(tmpdir(), 'flowx-ah-'))
  const proj = mkdtempSync(join(tmpdir(), 'flowx-ap-'))
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
