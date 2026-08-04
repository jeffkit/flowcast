// test/dashboard-config.test.js — config-store 原语单测。
//
// 全程临时 HOME + 临时项目目录，不碰真实 ~/.flowcast/agents.json。
// 遵守 AGENTS.md「测试用假执行器」约定：不烧 API、不依赖外部环境。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configFilePath, readConfigLayer, writeConfigLayer,
  saveAgentProfile, deleteAgentProfile,
  saveProvider, deleteProvider,
  listKnownExecutors, ENV_REF_RE,
} from '../dashboard/config-store.js'

function tempHome() { return mkdtempSync(join(tmpdir(), 'flowcast-cfg-home-')) }
function tempRepo() {
  const r = mkdtempSync(join(tmpdir(), 'flowcast-cfg-repo-'))
  mkdirSync(join(r, '.flowcast'), { recursive: true })
  return r
}

// ── 路径解析 ──────────────────────────────────────────────────────

test('configFilePath：user scope → ~/.flowcast/agents.json', () => {
  const home = tempHome()
  try {
    const f = configFilePath('agents', { scope: 'user', home })
    assert.equal(f, join(home, '.flowcast', 'agents.json'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('configFilePath：project scope → <repo>/.flowcast/agents.json', () => {
  const repo = tempRepo()
  try {
    const f = configFilePath('agents', { scope: 'project', repo })
    assert.equal(f, join(repo, '.flowcast', 'agents.json'))
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── readConfigLayer ───────────────────────────────────────────────

test('readConfigLayer：文件不存在返回空对象', () => {
  const home = tempHome()
  try {
    const f = configFilePath('agents', { scope: 'user', home })
    assert.deepEqual(readConfigLayer(f, 'agents'), {})
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('readConfigLayer：读 { agents: {...} } 外壳格式', () => {
  const home = tempHome()
  try {
    mkdirSync(join(home, '.flowcast'), { recursive: true })
    writeFileSync(join(home, '.flowcast', 'agents.json'), JSON.stringify({
      agents: { claude: { executor: 'claude' } },
      '//': 'comment key',
    }))
    const f = configFilePath('agents', { scope: 'user', home })
    const agents = readConfigLayer(f, 'agents')
    assert.equal(agents.claude.executor, 'claude')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('readConfigLayer：坏 JSON 抛 ECONFIG_PARSE', () => {
  const home = tempHome()
  try {
    mkdirSync(join(home, '.flowcast'), { recursive: true })
    writeFileSync(join(home, '.flowcast', 'agents.json'), '{ bad json')
    const f = configFilePath('agents', { scope: 'user', home })
    assert.throws(() => readConfigLayer(f, 'agents'), /JSON 解析失败/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── writeConfigLayer（保留未知字段 + 备份）──────────────────────

test('writeConfigLayer：保留未知顶层 key（//）+ 生成 .bak', () => {
  const home = tempHome()
  try {
    const dir = join(home, '.flowcast')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'agents.json')
    writeFileSync(file, JSON.stringify({ agents: {}, '//': 'keep me' }))

    writeConfigLayer(file, { agents: { x: { executor: 'claude' } }, '//': 'keep me' })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw['//'], 'keep me', '未知 key 应保留')
    assert.equal(raw.agents.x.executor, 'claude')
    assert.ok(existsSync(`${file}.bak`), '应生成 .bak 备份')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── saveAgentProfile ─────────────────────────────────────────────

test('saveAgentProfile：合法 profile 写入成功', () => {
  const home = tempHome()
  try {
    const result = saveAgentProfile({
      name: 'my-claude',
      profile: { executor: 'claude', model: 'claude-sonnet-4-5', timeout: 1800000 },
      scope: 'user', home,
    })
    assert.equal(result.name, 'my-claude')
    assert.equal(result.profile.executor, 'claude')

    const f = configFilePath('agents', { scope: 'user', home })
    const agents = readConfigLayer(f, 'agents')
    assert.equal(agents['my-claude'].executor, 'claude')
    assert.equal(agents['my-claude'].timeout, 1800000)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：缺 executor → EBAD_EXECUTOR', () => {
  const home = tempHome()
  try {
    assert.throws(() => saveAgentProfile({
      name: 'bad', profile: { model: 'x' }, scope: 'user', home,
    }), /缺少 executor/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：未知 executor → EBAD_EXECUTOR', () => {
  const home = tempHome()
  try {
    assert.throws(() => saveAgentProfile({
      name: 'bad', profile: { executor: 'nonexistent-cli' }, scope: 'user', home,
    }), /不在已知列表/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：非 BYO-LLM 配 provider → EBYD_NOT_ALLOWED', () => {
  const home = tempHome()
  try {
    // cursor 是 locked-in CLI，不允许配 provider
    assert.throws(() => saveAgentProfile({
      name: 'bad', profile: { executor: 'cursor', provider: 'deepseek' }, scope: 'user', home,
    }), /不支持自定义 provider/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：BYO-LLM 配 provider → 允许', () => {
  const home = tempHome()
  try {
    const result = saveAgentProfile({
      name: 'claude-ds',
      profile: { executor: 'claude', provider: 'deepseek' },
      scope: 'user', home,
    })
    assert.equal(result.profile.provider, 'deepseek')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：extraArgs 走白名单过滤', () => {
  const home = tempHome()
  try {
    // claude 白名单含 --dangerously-skip-permissions，不含 --evil-flag
    const result = saveAgentProfile({
      name: 'claude',
      profile: { executor: 'claude', extraArgs: ['--dangerously-skip-permissions', '--evil-flag'] },
      scope: 'user', home,
    })
    assert.deepEqual(result.profile.extraArgs, ['--dangerously-skip-permissions'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：非法名称 → EBAD_NAME', () => {
  const home = tempHome()
  try {
    assert.throws(() => saveAgentProfile({
      name: '../etc/passwd', profile: { executor: 'claude' }, scope: 'user', home,
    }), /非法名称/)
    assert.throws(() => saveAgentProfile({
      name: '.hidden', profile: { executor: 'claude' }, scope: 'user', home,
    }), /非法名称/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveAgentProfile：路径字段含 .. → EBAD_PATH', () => {
  const home = tempHome()
  try {
    assert.throws(() => saveAgentProfile({
      name: 'bad', profile: { executor: 'claude', transcriptOut: '../secret' }, scope: 'user', home,
    }), /transcriptOut/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── deleteAgentProfile ───────────────────────────────────────────

test('deleteAgentProfile：存在则删，不存在幂等', () => {
  const home = tempHome()
  try {
    saveAgentProfile({ name: 'x', profile: { executor: 'claude' }, scope: 'user', home })
    const r1 = deleteAgentProfile({ name: 'x', scope: 'user', home })
    assert.equal(r1.deleted, true)
    // 再删一次
    const r2 = deleteAgentProfile({ name: 'x', scope: 'user', home })
    assert.equal(r2.deleted, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── saveProvider ─────────────────────────────────────────────────

test('saveProvider：${ENV} 格式写入成功', () => {
  const home = tempHome()
  try {
    const result = saveProvider({
      name: 'deepseek',
      provider: { type: 'openai', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-v4', apiKey: '${DEEPSEEK_API_KEY}' },
      scope: 'user', home,
    })
    assert.equal(result.provider.apiKey, '${DEEPSEEK_API_KEY}')

    const f = configFilePath('providers', { scope: 'user', home })
    const providers = readConfigLayer(f, 'providers')
    assert.equal(providers.deepseek.apiKey, '${DEEPSEEK_API_KEY}')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveProvider：裸环境变量名自动包成 ${VAR}', () => {
  const home = tempHome()
  try {
    const result = saveProvider({
      name: 'glm',
      provider: { type: 'openai', apiKey: 'GLM_API_KEY' },
      scope: 'user', home,
    })
    assert.equal(result.provider.apiKey, '${GLM_API_KEY}')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveProvider：明文密钥 → EPLAINTEXT_KEY', () => {
  const home = tempHome()
  try {
    assert.throws(() => saveProvider({
      name: 'bad',
      provider: { apiKey: 'sk-1234567890abcdef' },
      scope: 'user', home,
    }), /明文|环境变量名/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveProvider：非法 type → EBAD_TYPE', () => {
  const home = tempHome()
  try {
    assert.throws(() => saveProvider({
      name: 'bad',
      provider: { type: 'weird', apiKey: '${X_KEY}' },
      scope: 'user', home,
    }), /openai 或 anthropic/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── deleteProvider ───────────────────────────────────────────────

test('deleteProvider：存在则删，不存在幂等', () => {
  const home = tempHome()
  try {
    saveProvider({ name: 'p', provider: { apiKey: '${X_KEY}' }, scope: 'user', home })
    assert.equal(deleteProvider({ name: 'p', scope: 'user', home }).deleted, true)
    assert.equal(deleteProvider({ name: 'p', scope: 'user', home }).deleted, false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── project scope ────────────────────────────────────────────────

test('project scope：写到 <repo>/.flowcast/', () => {
  const repo = tempRepo()
  try {
    saveAgentProfile({ name: 'proj-agent', profile: { executor: 'claude' }, scope: 'project', repo })
    const f = configFilePath('agents', { scope: 'project', repo })
    const agents = readConfigLayer(f, 'agents')
    assert.equal(agents['proj-agent'].executor, 'claude')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── listKnownExecutors ───────────────────────────────────────────

test('listKnownExecutors：返回已知列表 + BYO 标记', () => {
  const list = listKnownExecutors()
  const names = list.map(e => e.name)
  assert.ok(names.includes('claude'), '应含 claude')
  assert.ok(names.includes('cursor'), '应含 cursor')
  const claude = list.find(e => e.name === 'claude')
  assert.equal(claude.byoLlm, true, 'claude 应是 BYO-LLM')
  const cursor = list.find(e => e.name === 'cursor')
  assert.equal(cursor.byoLlm, false, 'cursor 应非 BYO-LLM')
})

// ── ENV_REF_RE ───────────────────────────────────────────────────

test('ENV_REF_RE：匹配 ${VAR} 格式', () => {
  assert.ok(ENV_REF_RE.test('${DEEPSEEK_API_KEY}'))
  assert.ok(ENV_REF_RE.test('${A}'))
  assert.ok(!ENV_REF_RE.test('sk-1234'), '明文不匹配')
  assert.ok(!ENV_REF_RE.test('${lowercase}'), '小写不匹配')
  assert.ok(!ENV_REF_RE.test('${1ABC}'), '数字开头不匹配')
})
