import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runFlow, fanOut } from '../subflow.js'
import { GOLDEN_SAMPLE } from '../orchestrator/paths.js'
import { flowcastDir } from '../dirs.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const cleanRun = (id) => rmSync(join(flowcastDir(REPO), 'runs', id), { recursive: true, force: true })

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fo-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  writeFileSync(join(dir, 'seed.txt'), 'seed')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

// ── runFlow ──────────────────────────────────────────────────────

test('runFlow: 子进程 dry-run 跑黄金样例 → ok, exit 0', async () => {
  const id = `t-rf-${Date.now()}`
  try {
    const r = await runFlow(GOLDEN_SAMPLE, { repo: REPO, runId: id, goal: 'a,b', dryRun: true, timeout: 30_000 })
    assert.equal(r.ok, true, r.stderr)
    assert.equal(r.exitCode, 0)
  } finally { cleanRun(id) }
})

test('runFlow: logFile 给定时输出重定向到文件', async () => {
  const id = `t-rf-log-${Date.now()}`
  const logFile = join(flowcastDir(REPO), 'runs', id, 'out.log')
  try {
    const r = await runFlow(GOLDEN_SAMPLE, { repo: REPO, runId: id, goal: 'x', dryRun: true, timeout: 30_000, logFile })
    assert.equal(r.ok, true, r.stderr)
    assert.ok(existsSync(logFile))
    assert.ok(readFileSync(logFile, 'utf8').length > 0)
    // 写文件时不应再走内存缓冲
    assert.equal(r.stdout, '')
  } finally { cleanRun(id) }
})

test('runFlow: 不认识的 flag 不会被自动注入（goal/agent 未给则不传）', async () => {
  // 黄金样例能接受 --goal/--agent，这里只验证 goal 省略时仍能跑（不强行注入 null）
  const id = `t-rf-noargs-${Date.now()}`
  try {
    const r = await runFlow(GOLDEN_SAMPLE, { repo: REPO, runId: id, dryRun: true, timeout: 30_000 })
    assert.equal(r.ok, true, r.stderr)
  } finally { cleanRun(id) }
})

// ── fanOut ───────────────────────────────────────────────────────

test('fanOut: 限并发跑多条子 flow，结果按序，onResult 每任务回调一次', async () => {
  const base = `t-fo-${Date.now()}`
  const ids = [`${base}-1`, `${base}-2`, `${base}-3`]
  const tasks = ids.map((id, i) => ({ name: id, flow: GOLDEN_SAMPLE, runId: id, goal: `t${i}` }))
  const seen = []
  try {
    const results = await fanOut(tasks, {
      repo: REPO, concurrency: 2, isolate: 'none', dryRun: true, timeout: 30_000,
      onResult: ({ task }) => seen.push(task.name),
    })
    assert.equal(results.length, 3)
    assert.ok(results.every(r => r.result.ok), 'all sub-flows should pass')
    // 结果保持 tasks 原序
    assert.deepEqual(results.map(r => r.task.name), ids)
    assert.equal(seen.length, 3)
  } finally { ids.forEach(cleanRun) }
})

test('fanOut: prepare 钩子在跑 flow 前被调用', async () => {
  const id = `t-fo-prep-${Date.now()}`
  let prepared = false
  try {
    await fanOut([{ name: id, flow: GOLDEN_SAMPLE, runId: id, goal: 'x' }], {
      repo: REPO, dryRun: true, timeout: 30_000,
      prepare: () => { prepared = true },
    })
    assert.equal(prepared, true)
  } finally { cleanRun(id) }
})

test('fanOut: 空任务列表 → 空结果，不报错', async () => {
  const results = await fanOut([], { repo: REPO, dryRun: true })
  assert.deepEqual(results, [])
})

test('fanOut: isolate=worktree 为每个任务建隔离工作树并在其中跑 flow', async () => {
  const repo = tempRepo()
  // 极简 flow：把 cwd 写进一个文件，证明它跑在 worktree 里
  const flowFile = join(repo, 'probe.mjs')
  writeFileSync(flowFile, `import { writeFileSync } from 'fs'\nwriteFileSync('cwd.txt', process.cwd())\n`)
  try {
    const results = await fanOut(
      [{ name: 'w1', flow: flowFile }, { name: 'w2', flow: flowFile }],
      { repo, concurrency: 2, isolate: 'worktree', dryRun: false, timeout: 30_000 },
    )
    assert.equal(results.length, 2)
    assert.ok(results.every(r => r.result.ok), results.map(r => r.result.stderr).join('\n'))
    for (const r of results) {
      assert.ok(r.worktree, '应创建 worktree')
      assert.ok(r.worktree.includes(join('.worktrees', r.task.name)))
      // flow 在 worktree 里跑：cwd.txt 落在 worktree 目录（用 basename 规避 macOS /private 软链）
      const cwdWritten = readFileSync(join(r.worktree, 'cwd.txt'), 'utf8')
      assert.ok(cwdWritten.endsWith(join('.worktrees', r.task.name)), `cwd=${cwdWritten}`)
    }
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
