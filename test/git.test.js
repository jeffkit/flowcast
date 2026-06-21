import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { existsSync } from 'node:fs'
import { gitCommitAll, gitStatus, gitDiff, gitWorktreeAdd, gitWorktreeRemove, gitHead, gitCurrentBranch, gitCommitsAhead, gitCreateBranch } from '../git.js'
import { GitError, PathError } from '../errors.js'

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-git-'))
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
  process.env.FLOWCAST_DRY_RUN = '1'
  try {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    const r = gitCommitAll(dir, 'x')
    assert.equal(r.dryRun, true)
    assert.equal(r.committed, false)
    assert.match(gitStatus(dir), /a\.txt/) // 仍未提交
  } finally {
    delete process.env.FLOWCAST_DRY_RUN
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
  process.env.FLOWCAST_DRY_RUN = '1'
  try {
    const wt = join(dir, '.worktrees', 'w-dry')
    const r = gitWorktreeAdd(dir, wt)
    assert.equal(r.dryRun, true)
    assert.equal(r.created, false)
    assert.ok(!existsSync(wt))
  } finally {
    delete process.env.FLOWCAST_DRY_RUN
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gitWorktreeAdd: 缺 dir 抛错', () => {
  assert.throws(() => gitWorktreeAdd('/tmp'), /需要 dir/)
})

test('gitHead/gitCurrentBranch/gitCommitsAhead: 分支与产出判断', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    gitCommitAll(dir, 'init')
    const base = gitHead(dir)
    assert.ok(/^[0-9a-f]{40}$/.test(base))

    // 新建并切到特性分支
    execFileSync('git', ['checkout', '-q', '-b', 'feat/x'], { cwd: dir })
    assert.equal(gitCurrentBranch(dir), 'feat/x')
    assert.equal(gitCommitsAhead(dir, base), 0)  // 还没新提交

    // 真有产出 → 提交数 > 0
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    gitCommitAll(dir, 'feat work')
    assert.equal(gitCommitsAhead(dir, base), 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitCurrentBranch: detached HEAD 返回 HEAD（空成功的特征）', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    gitCommitAll(dir, 'init')
    const sha = gitHead(dir)
    execFileSync('git', ['checkout', '-q', sha], { cwd: dir })  // detach
    assert.equal(gitCurrentBranch(dir), 'HEAD')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitCreateBranch: 从 detached HEAD 确定性建分支，再次调用切换复用', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    gitCommitAll(dir, 'init')
    const sha = gitHead(dir)
    execFileSync('git', ['checkout', '-q', sha], { cwd: dir })  // detach（模拟 worktree 初始态）
    assert.equal(gitCurrentBranch(dir), 'HEAD')

    const r = gitCreateBranch(dir, 'feat/y')
    assert.equal(r.created, true)
    assert.equal(gitCurrentBranch(dir), 'feat/y')

    // 已存在 → 切换复用，不抛
    execFileSync('git', ['checkout', '-q', sha], { cwd: dir })
    const r2 = gitCreateBranch(dir, 'feat/y')
    assert.equal(r2.created, false)
    assert.equal(gitCurrentBranch(dir), 'feat/y')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitCreateBranch: 缺 name 抛错', () => {
  assert.throws(() => gitCreateBranch('/tmp'), /需要 name/)
})

test('gitWorktreeAdd: 孤儿目录（存在但未注册）→ 抛明确错误', () => {
  const repo = tempRepo()
  const wt = join(repo, '.worktrees', 'orphan')
  try {
    // 手动创建目录，不通过 git worktree add——模拟孤儿目录
    mkdirSync(wt, { recursive: true })
    assert.throws(
      () => gitWorktreeAdd(repo, wt),
      /孤儿目录/,
    )
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── macOS realpath 兜底（/var/folders/... → /private/var/folders/...）──

test('gitWorktreeAdd: macOS 风格 symlink 路径（realpath 后比较）', () => {
  // macOS 上 /tmp、/var/folders/... 是 /private/var/folders/... 的 symlink
  // 输入路径不带 /private 前缀但 registered worktree 带，realpathSync 必须把它们
  // 规范成同一路径才能正确识别为合法（不是孤儿）。
  const repo = tempRepo()
  // tempRepo 不带 commit，worktree add 需要 HEAD commit 先建好
  writeFileSync(join(repo, 'a.txt'), 'init\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  const wt = join(repo, '.worktrees', 'macos-test')
  try {
    gitWorktreeAdd(repo, wt)
    // macOS 二次调用应识别为已注册（realpath 后路径一致）
    const r = gitWorktreeAdd(repo, wt)
    assert.equal(r.created, false, '已注册 worktree 应被复用')
    // Linux 上 /tmp 不是 symlink（realpath 不变），行为与 macOS 一致——这条
    // 测试是 macOS 行为的功能性覆盖，跨平台都能跑。
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('gitCreateBranch: 分支名含非法字符 → 抛 PathError', () => {
  const dir = tempRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'hi')
    gitCommitAll(dir, 'init')
    assert.throws(
      () => gitCreateBranch(dir, 'bad branch!'),
      (err) => {
        assert.ok(err instanceof PathError, `应为 PathError，实际：${err?.constructor?.name}`)
        return true
      },
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gitStatus: 非 git 目录 → 抛 GitError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-notgit-'))
  try {
    assert.throws(
      () => gitStatus(dir),
      (err) => {
        assert.ok(err instanceof GitError, `应为 GitError，实际：${err?.constructor?.name}`)
        return true
      },
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
