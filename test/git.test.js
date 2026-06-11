import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { gitCommitAll, gitStatus, gitDiff } from '../git.js'

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
