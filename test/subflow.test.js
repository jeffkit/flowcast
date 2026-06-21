import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runFlow, fanOut, sweepStaleTmp } from '../subflow.js'
import { GOLDEN_SAMPLE } from '../orchestrator/paths.js'
import { flowcastDir } from '../dirs.js'
import { PathError } from '../errors.js'

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

test('runFlow: timeout 极短时 timedOut=true', async () => {
  const flowDir = mkdtempSync(join(tmpdir(), 'flowcast-tmo-'))
  const flowFile = join(flowDir, 'slow.mjs')
  writeFileSync(flowFile, `await new Promise(r => setTimeout(r, 60000))\n`)
  try {
    const r = await runFlow(flowFile, { cwd: flowDir, timeout: 100 })
    assert.equal(r.timedOut, true, '极短 timeout 应标记 timedOut=true')
    assert.ok(!r.ok, 'timedOut 时 ok 应为 false')
  } finally { rmSync(flowDir, { recursive: true, force: true }) }
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

test('fanOut: task.name 含路径穿越字符 → 抛错', async () => {
  await assert.rejects(
    fanOut([{ name: '../evil', flow: 'x.mjs' }], { repo: REPO, dryRun: true }),
    (err) => {
      assert.ok(err instanceof PathError, `应为 PathError，实际：${err?.constructor?.name}`)
      assert.match(err.message, /非法字符/)
      return true
    },
  )
})

test('fanOut: 一个 flow 非零退出（软失败）→ 返回 2 个结果，失败项 ok===false，整体不 throw', async () => {
  const flowDir = mkdtempSync(join(tmpdir(), 'flowcast-fo-soft-'))
  const failFlow = join(flowDir, 'fail.mjs')
  const okFlow = join(flowDir, 'ok.mjs')
  writeFileSync(failFlow, `process.exit(1)\n`)
  writeFileSync(okFlow, `// noop\n`)
  try {
    const results = await fanOut(
      [
        { name: 'task-fail', flow: failFlow },
        { name: 'task-ok', flow: okFlow },
      ],
      { repo: flowDir, isolate: 'none', dryRun: false, timeout: 10_000 },
    )
    assert.equal(results.length, 2)
    const failResult = results.find(r => r.task.name === 'task-fail')
    const okResult = results.find(r => r.task.name === 'task-ok')
    assert.ok(failResult, '应有 task-fail 结果')
    assert.ok(okResult, '应有 task-ok 结果')
    assert.equal(failResult.result.ok, false, '非零退出的 flow ok 应为 false')
    assert.equal(okResult.result.ok, true, '正常退出的 flow ok 应为 true')
  } finally { rmSync(flowDir, { recursive: true, force: true }) }
})

test('fanOut: cleanWorktrees=true 时 fanOut 返回后 worktree 已被清理', async () => {
  const repo = tempRepo()
  const flowFile = join(repo, 'noop.mjs')
  writeFileSync(flowFile, `// noop\n`)
  try {
    const results = await fanOut(
      [{ name: 'w1', flow: flowFile }],
      { repo, isolate: 'worktree', cleanWorktrees: true, dryRun: false, timeout: 30_000 },
    )
    assert.equal(results.length, 1)
    const wt = results[0].worktree
    assert.ok(wt, '应有 worktree 路径')
    assert.equal(existsSync(wt), false, 'cleanWorktrees=true 时 worktree 应已清理')
  } finally { rmSync(repo, { recursive: true, force: true }) }
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

// ── F2: subflow 信号透传 + stale 临时文件清理 ───────────────────

test('runFlow: 父进程收 SIGTERM 时主动转发给子进程（不留孤儿）', async () => {
  // 跑一个 sleep 子进程，验证父进程收 SIGTERM 时子进程被 kill
  // 用一个写好 echo 'running' + sleep 的临时 flow 文件
  const flowDir = mkdtempSync(join(tmpdir(), 'flowcast-sigfwd-'))
  const flowFile = join(flowDir, 'flow.mjs')
  writeFileSync(flowFile, `
    import { setTimeout as wait } from 'node:timers/promises'
    process.stdout.write('running\\n')
    await wait(30000)  // 30s
  `)
  try {
    const proc = new Promise((resolve) => {
      const r = runFlow(flowFile, { cwd: flowDir, timeout: 30_000, dryRun: true })
      // 等子进程跑到 'running'
      setTimeout(() => {
        // 模拟父进程收 SIGTERM
        process.emit('SIGTERM')
        resolve(r)
      }, 500)
    })
    const result = await proc
    // 子进程应该被 kill 退出
    assert.notEqual(result.exitCode, 0, '子进程被信号杀掉时 exitCode 非 0')
  } finally { rmSync(flowDir, { recursive: true, force: true }) }
})

test('sweepStaleTmp: 清理超龄的 flowcast-codex-* 与 legacy flowx-codex-* 临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-sweep-'))
  const stale = join(dir, 'flowcast-codex-stale-test.txt')
  const legacyStale = join(dir, 'flowx-codex-legacy-stale.txt')
  const fresh = join(dir, 'flowcast-codex-fresh-test.txt')
  writeFileSync(stale, 'stale')
  writeFileSync(legacyStale, 'legacy stale')
  writeFileSync(fresh, 'fresh')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  utimesSync(stale, twoHoursAgo, twoHoursAgo)
  utimesSync(legacyStale, twoHoursAgo, twoHoursAgo)
  const removed = sweepStaleTmp({ baseDir: dir, olderThanMs: 60 * 60 * 1000 })
  assert.ok(removed.includes('flowcast-codex-stale-test.txt'), 'flowcast stale 应被清')
  assert.ok(removed.includes('flowx-codex-legacy-stale.txt'), 'legacy flowx stale 应被清')
  assert.ok(!existsSync(stale), 'stale 文件应已被删')
  assert.ok(existsSync(fresh), 'fresh 文件应保留')
  rmSync(dir, { recursive: true, force: true })
})

test('sweepStaleTmp: 保留其他工具的 tmp 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-sweep-safe-'))
  // 别人的 tmp 文件（不同前缀）应不动
  const other = join(dir, 'some-tool-tempfile.tmp')
  writeFileSync(other, 'x')
  utimesSync(other, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000))
  sweepStaleTmp({ baseDir: dir, olderThanMs: 60 * 60 * 1000 })
  assert.ok(existsSync(other), '其他工具的 tmp 文件应保留')
  rmSync(dir, { recursive: true, force: true })
})
