import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// 隔离持久化：覆盖 HOME 指向临时目录
let tmpHome
before(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'flowcast-rl-test-'))
  process.env.HOME = tmpHome
})
after(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.HOME
})

const {
  matchPattern, recordRateLimit, getAvailableAt, isAvailable,
  listRateLimits, clearRateLimit, listPatterns, removePattern, makeKey,
} = await import('../rate-limiter.js')

// ── 工具：直接写特征库（绕过 LLM，单元测试用）────────────────────────

function seedPatterns(patterns) {
  const dir = join(homedir(), '.flowcast')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rl-patterns.json'), JSON.stringify(patterns, null, 2))
}

function nextMondayUTC(from = Date.now()) {
  const d = new Date(from)
  const daysUntil = d.getUTCDay() === 0 ? 1 : (8 - d.getUTCDay()) % 7 || 7
  d.setUTCDate(d.getUTCDate() + daysUntil)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}

// ── makeKey ───────────────────────────────────────────────────────────

test('makeKey: 有 model 时拼接', () => {
  assert.equal(makeKey('gemini', 'gemini-2.5-pro'), 'gemini/gemini-2.5-pro')
})

test('makeKey: model 为空时用 default', () => {
  assert.equal(makeKey('agy', ''), 'agy/default')
  assert.equal(makeKey('agy', null), 'agy/default')
})

// ── matchPattern：特征库为空时 ────────────────────────────────────────

test('matchPattern: 特征库为空 → null', () => {
  seedPatterns([])
  assert.equal(matchPattern('gemini', 'gemini-2.5-pro', 'rate limit exceeded'), null)
})

// ── matchPattern：window 类型 ─────────────────────────────────────────

test('matchPattern: window 类型 → 从当前时刻加 windowMs', () => {
  seedPatterns([{
    id: 'test/1',
    cli: 'agy', model: 'glm-4-flash',
    match: 'rate limit exceeded',
    windowMs: 5 * 3_600_000,
    resetType: 'window',
    extractRe: null,
  }])
  const now = Date.now()
  const hit = matchPattern('agy', 'glm-4-flash', 'Error: rate limit exceeded for this model')
  assert.ok(hit !== null, '应命中特征')
  assert.ok(hit.availableAt >= now + 5 * 3_600_000 - 1000)
  assert.equal(hit.pattern.cli, 'agy')
})

// ── matchPattern：weekly 类型 ─────────────────────────────────────────

test('matchPattern: weekly 类型 → 取 windowMs 与下周一较晚', () => {
  seedPatterns([{
    id: 'test/2',
    cli: 'agy', model: 'glm-4-flash',
    match: 'weekly quota',
    windowMs: 3_600_000,
    resetType: 'weekly',
    extractRe: null,
  }])
  const hit = matchPattern('agy', 'glm-4-flash', 'weekly quota exceeded')
  assert.ok(hit !== null)
  assert.ok(hit.availableAt >= nextMondayUTC() - 1000, '应至少到下周一')
})

// ── matchPattern：absolute 类型 ───────────────────────────────────────

test('matchPattern: absolute 类型 → extractRe 提取绝对时间', () => {
  const future = new Date(Date.now() + 7_200_000).toISOString()
  seedPatterns([{
    id: 'test/3',
    cli: 'gemini', model: null,
    match: 'available at',
    windowMs: 3_600_000,
    resetType: 'absolute',
    extractRe: 'available at (\\d{4}-\\d{2}-\\d{2}T[^\\s]+)',
  }])
  const hit = matchPattern('gemini', 'gemini-2.5-pro', `Rate limited. available at ${future}`)
  assert.ok(hit !== null)
  assert.ok(Math.abs(hit.availableAt - Date.parse(future)) < 2000)
})

// ── matchPattern：cli/model 范围 ──────────────────────────────────────

test('matchPattern: cli=null 的通用特征匹配任意 cli', () => {
  seedPatterns([{
    id: 'test/4',
    cli: null, model: null,
    match: 'quota exceeded',
    windowMs: 3_600_000,
    resetType: 'window',
    extractRe: null,
  }])
  const hit = matchPattern('some-unknown-cli', 'any-model', 'Error: quota exceeded')
  assert.ok(hit !== null)
})

test('matchPattern: cli 不匹配时不命中', () => {
  seedPatterns([{
    id: 'test/5',
    cli: 'agy', model: null,
    match: 'rate limit',
    windowMs: 3_600_000,
    resetType: 'window',
    extractRe: null,
  }])
  const hit = matchPattern('gemini', null, 'rate limit exceeded')
  assert.equal(hit, null)
})

test('matchPattern: 正则无效时跳过该特征', () => {
  seedPatterns([{
    id: 'test/bad-re',
    cli: null, model: null,
    match: '[invalid regex(',
    windowMs: 3_600_000,
    resetType: 'window',
    extractRe: null,
  }])
  const hit = matchPattern('agy', null, 'rate limit')
  assert.equal(hit, null)
})

// ── recordRateLimit：特征命中路径 ─────────────────────────────────────

test('recordRateLimit: 特征命中 → source=pattern', async () => {
  seedPatterns([{
    id: 'test/6',
    cli: 'test-cli', model: null,
    match: 'test rate limit',
    windowMs: 7_200_000,
    resetType: 'window',
    extractRe: null,
  }])
  const { source, availableAt } = await recordRateLimit('test-cli', 'test-model', 'test rate limit hit')
  assert.equal(source, 'pattern')
  assert.ok(availableAt > Date.now() + 7_000_000)
})

test('recordRateLimit: 无特征无 output → source=default, 1h 冷却', async () => {
  seedPatterns([])
  const now = Date.now()
  const { source, availableAt } = await recordRateLimit('unknown-cli', 'unknown-model', '')
  assert.equal(source, 'default')
  assert.ok(availableAt >= now + 3_600_000 - 1000)
})

// ── getAvailableAt / isAvailable ─────────────────────────────────────

test('getAvailableAt: 记录存在 → 返回剩余信息', async () => {
  seedPatterns([{
    id: 'test/7', cli: 'ga-cli', model: null, match: 'blocked',
    windowMs: 3_600_000, resetType: 'window', extractRe: null,
  }])
  await recordRateLimit('ga-cli', 'ga-model', 'blocked by rate limit')
  const r = getAvailableAt('ga-cli', 'ga-model')
  assert.ok(r !== null)
  assert.ok(r.remainingMs > 0)
  assert.equal(r.source, 'pattern')
})

test('getAvailableAt: 无记录 → null', () => {
  assert.equal(getAvailableAt('no-such-cli', 'no-such-model'), null)
})

test('isAvailable: 有记录 → false', async () => {
  seedPatterns([{
    id: 'test/8', cli: 'ia-cli', model: null, match: 'blocked',
    windowMs: 3_600_000, resetType: 'window', extractRe: null,
  }])
  await recordRateLimit('ia-cli', 'ia-model', 'blocked')
  assert.equal(isAvailable('ia-cli', 'ia-model'), false)
})

test('isAvailable: 无记录 → true', () => {
  assert.equal(isAvailable('free-cli', 'free-model'), true)
})

// ── clearRateLimit ────────────────────────────────────────────────────

test('clearRateLimit: 清除后变可用', async () => {
  seedPatterns([{
    id: 'test/9', cli: 'cl-cli', model: null, match: 'blocked',
    windowMs: 3_600_000, resetType: 'window', extractRe: null,
  }])
  await recordRateLimit('cl-cli', 'cl-model', 'blocked')
  assert.equal(isAvailable('cl-cli', 'cl-model'), false)
  clearRateLimit('cl-cli', 'cl-model')
  assert.equal(isAvailable('cl-cli', 'cl-model'), true)
})

// ── listRateLimits ────────────────────────────────────────────────────

test('listRateLimits: 返回活跃条目，按 remainingMs 升序', async () => {
  seedPatterns([
    { id: 't/a', cli: 'lrl-a', model: null, match: 'blocked', windowMs: 3_600_000, resetType: 'window', extractRe: null },
    { id: 't/b', cli: 'lrl-b', model: null, match: 'blocked', windowMs: 7_200_000, resetType: 'window', extractRe: null },
  ])
  clearRateLimit('lrl-a', 'ma')
  clearRateLimit('lrl-b', 'mb')
  await recordRateLimit('lrl-a', 'ma', 'blocked')
  await recordRateLimit('lrl-b', 'mb', 'blocked')
  const list = listRateLimits()
  const keys = list.map(e => e.key)
  assert.ok(keys.includes('lrl-a/ma'))
  assert.ok(keys.includes('lrl-b/mb'))
  assert.ok(keys.indexOf('lrl-a/ma') < keys.indexOf('lrl-b/mb'), '1h 应排在 2h 前面')
})

// ── listPatterns / removePattern ──────────────────────────────────────

test('listPatterns: 返回特征库内容', () => {
  seedPatterns([
    { id: 'p1', cli: 'x', model: null, match: 'foo', windowMs: 1000, resetType: 'window', extractRe: null },
    { id: 'p2', cli: 'y', model: null, match: 'bar', windowMs: 2000, resetType: 'window', extractRe: null },
  ])
  const list = listPatterns()
  assert.equal(list.length, 2)
  assert.ok(list.some(p => p.id === 'p1'))
})

test('removePattern: 删除指定 id', () => {
  seedPatterns([
    { id: 'del-1', cli: 'x', model: null, match: 'foo', windowMs: 1000, resetType: 'window', extractRe: null },
    { id: 'del-2', cli: 'y', model: null, match: 'bar', windowMs: 2000, resetType: 'window', extractRe: null },
  ])
  removePattern('del-1')
  const list = listPatterns()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'del-2')
})
