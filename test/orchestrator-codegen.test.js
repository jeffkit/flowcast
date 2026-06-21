import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateFlow, extractCode, runGeneratedFlow, orchestrate, checkFlowcastResolvable } from '../orchestrator/index.js'
import { GOLDEN_SAMPLE } from '../orchestrator/paths.js'
import { flowcastDir } from '../dirs.js'
import { LockError } from '../errors.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const goldenCode = readFileSync(GOLDEN_SAMPLE, 'utf8')
const fence = (code) => '```js\n' + code + '\n```'
const cleanRun = (id) => rmSync(join(flowcastDir(REPO), 'runs', id), { recursive: true, force: true })

// ── extractCode ──────────────────────────────────────────────────

test('extractCode: 取代码块 / 裸文本', () => {
  assert.equal(extractCode('blah\n```js\nconst a=1\n```\nend'), 'const a=1')
  assert.equal(extractCode('const b=2'), 'const b=2')
})

// ── M3 generateFlow（fake agent，不烧 API）───────────────────────

test('generateFlow: 注入好代码一次过', async () => {
  const id = `t-gen-ok-${Date.now()}`
  const runDir = join(flowcastDir(REPO), 'runs', id)
  try {
    const r = await generateFlow('analyze src', { repo: REPO, runDir, generate: async () => fence(goldenCode) })
    assert.equal(r.validation.ok, true, r.validation.error)
    assert.equal(r.attempts, 1)
  } finally { cleanRun(id) }
})

test('generateFlow: 首次违规 → 回喂错误 → 第二次修正（attempts=2）', async () => {
  const id = `t-gen-retry-${Date.now()}`
  const runDir = join(flowcastDir(REPO), 'runs', id)
  let n = 0
  const gen = async () => { n++; return n === 1 ? fence("import { x } from 'fs'\nawait Promise.resolve()") : fence(goldenCode) }
  try {
    const r = await generateFlow('x', { repo: REPO, runDir, generate: gen, maxAttempts: 2 })
    assert.equal(r.validation.ok, true, r.validation.error)
    assert.equal(r.attempts, 2)
  } finally { cleanRun(id) }
})

test('generateFlow: 始终违规 → ok false', async () => {
  const id = `t-gen-bad-${Date.now()}`
  const runDir = join(flowcastDir(REPO), 'runs', id)
  try {
    const r = await generateFlow('x', { repo: REPO, runDir, maxAttempts: 2,
      generate: async () => fence("import { x } from 'fs'\nawait Promise.resolve()") })
    assert.equal(r.validation.ok, false)
    assert.match(r.validation.error, /imports/)
  } finally { cleanRun(id) }
})

// ── M4 runGeneratedFlow ──────────────────────────────────────────

test('runGeneratedFlow: 子进程 dry-run 跑黄金样例 exit 0', async () => {
  const id = `t-run-${Date.now()}`
  try {
    const r = await runGeneratedFlow(GOLDEN_SAMPLE, { repo: REPO, runId: id, goal: 'a,b', dryRun: true, timeout: 30_000 })
    assert.equal(r.exitCode, 0, r.stderr)
  } finally { cleanRun(id) }
})

// ── 跑前预检：目标仓必须能解析 flowcast ──────────────────

test('checkFlowcastResolvable: 本包仓自引用可解析', () => {
  assert.equal(checkFlowcastResolvable(REPO).ok, true)
})

test('checkFlowcastResolvable: 无依赖的临时仓 → 友好报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-noresolve-'))
  try {
    const r = checkFlowcastResolvable(dir)
    assert.equal(r.ok, false)
    assert.match(r.error, /flowcast/)
    assert.match(r.error, /npm install/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('orchestrate: 目标仓不可解析本包 → stage=precheck，不生成不执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-precheck-'))
  let genCalled = false
  try {
    const r = await orchestrate('x', {
      repo: dir, runId: 'pc-1', dryRun: true,
      generate: async () => { genCalled = true; return '```js\n```' },
    })
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'precheck')
    assert.equal(genCalled, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('orchestrate: 僵尸锁（已死 PID + 旧 startedAt）→ 自动清理并续跑', async () => {
  const id = `t-zombie-${Date.now()}`
  try {
    // 第一次正常跑通，产物落地
    const r1 = await orchestrate('analyze', {
      repo: REPO, runId: id, generate: async () => fence(goldenCode), dryRun: true, timeout: 30_000,
    })
    assert.equal(r1.ok, true)

    // 注入一个僵尸锁：lockDir 已存在 + owner.pid 是死 PID + startedAt 超 1h
    const lockDir = join(flowcastDir(REPO), 'runs', id, '.lock')
    const { mkdirSync: mk, writeFileSync: wr } = await import('node:fs')
    mk(lockDir, { recursive: true })
    wr(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 999_999, // 不可能活着的 PID
      startedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 小时前
      runId: id,
    }))
    // 跑第二次——必须识别僵尸、自动 rm -rf lockDir、走 reuse 路径
    let genCalled = false
    const r2 = await orchestrate('analyze', {
      repo: REPO, runId: id, dryRun: true, timeout: 30_000,
      generate: async () => { genCalled = true; return fence('bad') },
    })
    assert.equal(r2.reused, true, '应当 reuse 已存在的 flow.mjs')
    assert.equal(genCalled, false)
    assert.equal(r2.ok, true)
  } finally { cleanRun(id) }
})

test('orchestrate: 活进程持有锁（owner.pid 还活着）→ 抛错而非偷偷重试', async () => {
  const id = `t-busy-${Date.now()}`
  try {
    // 第一次跑通
    await orchestrate('x', {
      repo: REPO, runId: id, generate: async () => fence(goldenCode), dryRun: true, timeout: 30_000,
    })
    // 注入一个「活进程持有」的锁：PID 是当前 node 进程（必定活着）+ 新 startedAt
    const lockDir = join(flowcastDir(REPO), 'runs', id, '.lock')
    const { mkdirSync: mk, writeFileSync: wr } = await import('node:fs')
    mk(lockDir, { recursive: true })
    wr(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid, // 当前 node 进程
      startedAt: Date.now(),
      runId: id,
    }))
    // 跑第二次——必须识别活锁、抛错（不偷偷删、不走 reuse）
    let genCalled = false
    await assert.rejects(
      orchestrate('x', {
        repo: REPO, runId: id, dryRun: true, timeout: 30_000,
        generate: async () => { genCalled = true; return fence('bad') },
      }),
      (err) => {
        assert.ok(err instanceof LockError, `应为 LockError，实际：${err?.constructor?.name}`)
        assert.strictEqual(err.code, 'LOCK_BUSY')
        assert.match(err.message, /正在被 pid=.* 执行/)
        return true
      },
    )
    assert.equal(genCalled, false)
  } finally { cleanRun(id) }
})

// ── M5 端到端 + 续跑锁定 ─────────────────────────────────────────

test('acquireLock: lockDir 存在但 owner.json 缺失且 mtime 尚新 → 抛 LockError LOCK_OWNER_PENDING', async () => {
  const id = `t-owner-pending-${Date.now()}`
  try {
    // 手动创建 lockDir 但不写 owner.json，模拟「owner 还没来得及写盘」的竞态窗口
    const runDir = join(flowcastDir(REPO), 'runs', id)
    const lockDir = join(runDir, '.lock')
    mkdirSync(lockDir, { recursive: true })
    // orchestrate 进来 → mkdirSync(lockDir) 抛 EEXIST → 等待 owner.json，等不到 → 检查 mtime → mtime 尚新 → 抛错
    await assert.rejects(
      orchestrate('x', { repo: REPO, runId: id, dryRun: true, generate: async () => fence(goldenCode) }),
      (err) => {
        assert.ok(err instanceof LockError, `应为 LockError，实际：${err?.constructor?.name}`)
        assert.strictEqual(err.code, 'LOCK_OWNER_PENDING')
        return true
      },
    )
  } finally { cleanRun(id) }
})

test('orchestrate: 需求→生成→校验→dry-run 真跑；同 runId 续跑锁定不重生成', async () => {
  const id = `t-orch-${Date.now()}`
  try {
    const r1 = await orchestrate('analyze the repo', {
      repo: REPO, runId: id, generate: async () => fence(goldenCode), dryRun: true, timeout: 30_000,
    })
    assert.equal(r1.ok, true, r1.stderr || r1.error)
    assert.equal(r1.reused, false)
    assert.equal(r1.attempts, 1)

    // 续跑：flow.mjs 已存在 → reused，generate 不应被调用
    let genCalled = false
    const r2 = await orchestrate('analyze the repo', {
      repo: REPO, runId: id, dryRun: true, timeout: 30_000,
      generate: async () => { genCalled = true; return fence('bad') },
    })
    assert.equal(r2.reused, true)
    assert.equal(genCalled, false)
    assert.equal(r2.ok, true, r2.stderr)
  } finally { cleanRun(id) }
})
