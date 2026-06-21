import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { interpolateEnv, loadProviders, resolveProvider } from '../provider.js'
import { recursiveProviderEnv } from '../agent.js'
import { ConfigError } from '../errors.js'

// ── interpolateEnv ───────────────────────────────────────────────

test('interpolateEnv: 基本插值', () => {
  assert.equal(interpolateEnv('${FOO}', { FOO: 'bar' }), 'bar')
})

test('interpolateEnv: 前后缀混合 + 多次出现', () => {
  const env = { USER: 'kj', SUFFIX: '99' }
  assert.equal(interpolateEnv('hi ${USER}, key ends ${SUFFIX}', env), 'hi kj, key ends 99')
})

test('interpolateEnv: $$ 转义为字面 $（不查 env）', () => {
  assert.equal(interpolateEnv('$$HOME', { HOME: '/x' }), '$HOME')
  assert.equal(interpolateEnv('price $$5', {}), 'price $5')
})

test('interpolateEnv: 未定义变量 fail-fast', () => {
  assert.throws(
    () => interpolateEnv('${MISSING}', {}),
    (err) => {
      assert.match(err.message, /MISSING 未设置/)
      assert.ok(err instanceof ConfigError, `应为 ConfigError，实际：${err?.constructor?.name}`)
      return true
    },
  )
})

test('interpolateEnv: 显式空串合法', () => {
  assert.equal(interpolateEnv('[${E}]', { E: '' }), '[]')
})

test('interpolateEnv: 无 ${} 原样返回', () => {
  assert.equal(interpolateEnv('plain', {}), 'plain')
})

test('interpolateEnv: 非法 token 报错', () => {
  assert.throws(() => interpolateEnv('${1BAD}', { '1BAD': 'x' }), /非法插值 token/)
  assert.throws(() => interpolateEnv('${A B}', {}), /非法插值 token/)
})

// ── resolveProvider ──────────────────────────────────────────────

const PROVIDERS = {
  deepseek: { type: 'openai', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', apiKey: '${DS_KEY}' },
  legacy: { type: 'openai', base: 'https://legacy.example/v1', model: 'old', keyEnv: 'LEGACY_KEY' },
}

test('resolveProvider: 命名解析 + key 插值', () => {
  const b = resolveProvider('deepseek', PROVIDERS, { DS_KEY: 'sk-123' })
  assert.equal(b.type, 'openai')
  assert.equal(b.apiBase, 'https://api.deepseek.com/v1')
  assert.equal(b.model, 'deepseek-v4-pro')
  assert.equal(b.apiKey, 'sk-123')
})

test('resolveProvider: 兼容旧字段 base/keyEnv', () => {
  const b = resolveProvider('legacy', PROVIDERS, { LEGACY_KEY: 'sk-old' })
  assert.equal(b.apiBase, 'https://legacy.example/v1')
  assert.equal(b.apiKey, 'sk-old')
})

test('resolveProvider: name 为空返回 null', () => {
  assert.equal(resolveProvider(undefined, PROVIDERS), null)
})

test('resolveProvider: 未知 provider 报错并列出已定义', () => {
  assert.throws(() => resolveProvider('nope', PROVIDERS, {}), /未知 provider 'nope'.*deepseek/s)
})

test('resolveProvider: key 环境变量缺失则 fail-fast', () => {
  assert.throws(() => resolveProvider('deepseek', PROVIDERS, {}), /DS_KEY 未设置/)
})

test('interpolateEnv: 未定义变量错误含原始模板片段', () => {
  assert.throws(
    () => interpolateEnv('base=${API_BASE}/v1', {}),
    (err) => {
      assert.match(err.message, /API_BASE 未设置/)
      assert.match(err.message, /base=/, '错误应包含原始模板前缀')
      return true
    },
  )
})

// ── loadProviders（多层合并）─────────────────────────────────────

test('loadProviders: 项目级覆盖机器级', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flowcast-home-'))
  const proj = mkdtempSync(join(tmpdir(), 'flowcast-proj-'))
  try {
    mkdirSync(join(home, '.flowx'), { recursive: true })
    mkdirSync(join(proj, '.flowx'), { recursive: true })
    writeFileSync(join(home, '.flowx', 'providers.json'), JSON.stringify({
      providers: { a: { type: 'openai', apiBase: 'home-a', model: 'm' }, b: { type: 'openai', apiBase: 'home-b', model: 'm' } },
    }))
    writeFileSync(join(proj, '.flowx', 'providers.json'), JSON.stringify({
      providers: { b: { type: 'openai', apiBase: 'proj-b', model: 'm' } },
    }))
    const merged = await loadProviders({ dirs: [join(home, '.flowx'), join(proj, '.flowx')] })
    assert.equal(merged.a.apiBase, 'home-a')      // 仅机器级有
    assert.equal(merged.b.apiBase, 'proj-b')      // 项目级覆盖
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})

test('loadProviders: 无配置返回空 map', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'flowcast-empty-'))
  try {
    const merged = await loadProviders({ dirs: [join(empty, 'nope')] })
    assert.deepEqual(merged, {})
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

// ── recursiveProviderEnv（recursive 专属翻译）────────────────────

test('recursiveProviderEnv: bundle → RECURSIVE_* env', () => {
  const env = recursiveProviderEnv({ type: 'openai', apiBase: 'https://x/v1', model: 'm', apiKey: 'k', maxSteps: 40 })
  assert.deepEqual(env, {
    RECURSIVE_PROVIDER_TYPE: 'openai',
    RECURSIVE_API_BASE: 'https://x/v1',
    RECURSIVE_MODEL: 'm',
    RECURSIVE_API_KEY: 'k',
    RECURSIVE_MAX_STEPS: '40',
  })
})

test('recursiveProviderEnv: 缺字段则省略，无 maxSteps 不写', () => {
  const env = recursiveProviderEnv({ type: 'openai', model: 'm' })
  assert.deepEqual(env, { RECURSIVE_PROVIDER_TYPE: 'openai', RECURSIVE_MODEL: 'm' })
})

test('recursiveProviderEnv: 空参数返回空对象', () => {
  assert.deepEqual(recursiveProviderEnv(), {})
})
