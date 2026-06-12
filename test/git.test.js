import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { existsSync } from 'node:fs'
import { gitCommitAll, gitStatus, gitDiff, gitWorktreeAdd, gitWorktreeRemove } from '../git.js'

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'flowx-git-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  return dir
}

test('gitCommitAll: 提交改动，再次提交无改动则跳过', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    assert.match(gitStatus(dir), /a\.txt/)
    const r = gitCommitAll(dir, 'add a')
    assert.equal(r.committed, true)
    assert.ok(/^[0-9a-f]{40}$/.test(r.sha))
    const r2 = gitCommitAll(dir, 'again')
    assert.equal(r2.committed, false)
    assert.equal(r2.reason, 'nothing to commit')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitDiff: 反映未暂存改动', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    gitCommitAll(dir, 'init')
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    assert.match(gitDiff(dir), /-one/)
    assert.match(gitDiff(dir), /\+two/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitCommitAll: dry-run 不实际提交', () => {
  const dir = tempRepo()
  process.env.FLOWX_DRY_RUN = '1'
  try {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    const r = gitCommitAll(dir, 'x')
    assert.equal(r.dryRun, true)
    assert.equal(r.committed, false)
    assert.match(gitStatus(dir), /a\.txt/) // 仍未提交
  } finally {
    delete process.env.FLOWX_DRY_RUN
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitWorktreeAdd/Remove: 新增隔离工作树，复用已存在，移除', () => {
  const dir = tempRepo()
  writeFileSync(join(dir, 'a.txt'), 'hi')
  gitCommitAll(dir, 'init')  // worktree add 需要至少一个 commit
  const wt = join(dir, '.worktrees', 'w1')
  try {
    const r = gitWorktreeAdd(dir, wt)
    assert.equal(r.created, true)
    assert.ok(existsSync(join(wt, 'a.txt')), 'worktree 应包含已提交文件')

    // 已存在 → 复用不报错
    const r2 = gitWorktreeAdd(dir, wt)
    assert.equal(r2.created, false)
    assert.equal(r2.reason, 'exists')

    const rm = gitWorktreeRemove(dir, wt)
    assert.equal(rm.removed, true)
    assert.ok(!existsSync(wt), 'worktree 目录应被移除')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitWorktreeAdd: dry-run 不实际创建', () => {
  const dir = tempRepo()
  process.env.FLOWX_DRY_RUN = '1'
  try {
    const wt = join(dir, '.worktrees', 'w-dry')
    const r = gitWorktreeAdd(dir, wt)
    assert.equal(r.dryRun, true)
    assert.equal(r.created, false)
    assert.ok(!existsSync(wt))
  } finally {
    delete process.env.FLOWX_DRY_RUN
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitWorktreeAdd: 缺 dir 抛错', () => {
  assert.throws(() => gitWorktreeAdd('/tmp'), /需要 dir/)
})
