import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateFlow, extractCode, runGeneratedFlow, orchestrate } from '../orchestrator/index.js'
import { GOLDEN_SAMPLE } from '../orchestrator/paths.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const goldenCode = readFileSync(GOLDEN_SAMPLE, 'utf8')
const fence = (code) => '```js\n' + code + '\n```'
const cleanRun = (id) => rmSync(join(REPO, '.flowx', 'runs', id), { recursive: true, force: true })

// ── extractCode ──────────────────────────────────────────────────

test('extractCode: 取代码块 / 裸文本', () => {
  assert.equal(extractCode('blah\n```js\nconst a=1\n```\nend'), 'const a=1')
  assert.equal(extractCode('const b=2'), 'const b=2')
})

// ── M3 generateFlow（fake agent，不烧 API）───────────────────────

test('generateFlow: 注入好代码一次过', async () => {
  const id = `t-gen-ok-${Date.now()}`
  const runDir = join(REPO, '.flowx', 'runs', id)
  try {
    const r = await generateFlow('analyze src', { repo: REPO, runDir, generate: async () => fence(goldenCode) })
    assert.equal(r.validation.ok, true, r.validation.error)
    assert.equal(r.attempts, 1)
  } finally { cleanRun(id) }
})

test('generateFlow: 首次违规 → 回喂错误 → 第二次修正（attempts=2）', async () => {
  const id = `t-gen-retry-${Date.now()}`
  const runDir = join(REPO, '.flowx', 'runs', id)
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
  const runDir = join(REPO, '.flowx', 'runs', id)
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

// ── M5 端到端 + 续跑锁定 ─────────────────────────────────────────

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
