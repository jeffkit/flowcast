// git.js — 生成的 flow 可用的 git 原语（从 flowcast 暴露，绕开 child_process 白名单）
//
// 生成的 flow 受 import 白名单约束（不能直接用 child_process），但常需要 git commit/diff。
// 通过 flowx 暴露这组受控 helper，让编排逻辑提交改动而无需裸调 shell。

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { isDryRun } from './dry-run.js'

// 内部 helper，供 self-mod-guard.js 共用；不经 index.js 对外暴露。
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function gitOk(args, cwd) {
  try { git(args, cwd); return true } catch { return false }
}

/** 工作树改动（porcelain）。 */
export function gitStatus(repo = process.cwd()) {
  return git(['status', '--porcelain'], repo)
}

/** diff（默认未暂存；staged=true 看已暂存）。 */
export function gitDiff(repo = process.cwd(), { staged = false } = {}) {
  return git(staged ? ['diff', '--cached'] : ['diff'], repo)
}

/** 当前 HEAD 的完整 sha。 */
export function gitHead(repo = process.cwd()) {
  return git(['rev-parse', 'HEAD'], repo)
}

/** 当前分支名；detached HEAD 时返回 'HEAD'。 */
export function gitCurrentBranch(repo = process.cwd()) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
}

/** HEAD 相对 baseRef（commit-ish）领先的提交数；用于判断「是否真有产出」。 */
export function gitCommitsAhead(repo = process.cwd(), baseRef = 'main') {
  return parseInt(git(['rev-list', '--count', `${baseRef}..HEAD`], repo), 10) || 0
}

/**
 * 确定性地创建/切换到分支（建分支是 git 操作，不该交给 LLM）。
 * 已存在则切换，否则从当前 HEAD 新建。dry-run 下不实际操作。
 * @returns {{branch:string, created:boolean, dryRun?:boolean}}
 */
export function gitCreateBranch(repo = process.cwd(), name) {
  if (!name) throw new Error('gitCreateBranch 需要 name')
  if (isDryRun()) return { branch: name, created: false, dryRun: true }
  const exists = !!git(['branch', '--list', name], repo)
  git(exists ? ['checkout', name] : ['checkout', '-b', name], repo)
  return { branch: name, created: !exists }
}

/**
 * 暂存全部并提交；无改动则跳过。dry-run 下不实际提交。
 * @returns {{committed:boolean, sha?:string, dryRun?:boolean, reason?:string}}
 */
export function gitCommitAll(repo = process.cwd(), message = 'flowcast: automated commit') {
  if (isDryRun()) return { committed: false, dryRun: true }
  git(['add', '-A'], repo)
  if (!git(['status', '--porcelain'], repo)) return { committed: false, reason: 'nothing to commit' }
  git(['commit', '-m', message], repo)
  return { committed: true, sha: git(['rev-parse', 'HEAD'], repo) }
}

/**
 * 新增一个隔离 worktree（默认 detached，基于当前 HEAD 或指定 ref）。
 * 用途：fan-out 时给每个子任务一个独立工作树，互不污染。已存在则复用（支持续跑）。
 * dry-run 下不实际创建。
 * @param {string} repo  主 repo
 * @param {string} dir   worktree 目标目录
 * @param {object} [o]
 * @param {string} [o.ref]  基于哪个 commit-ish（默认 HEAD）
 * @returns {{dir:string, created:boolean, dryRun?:boolean, reason?:string}}
 */
export function gitWorktreeAdd(repo = process.cwd(), dir, { ref } = {}) {
  if (!dir) throw new Error('gitWorktreeAdd 需要 dir')
  if (isDryRun()) return { dir, created: false, dryRun: true }
  if (existsSync(dir)) return { dir, created: false, reason: 'exists' }
  const args = ['worktree', 'add', '--detach', dir]
  if (ref) args.push(ref)
  git(args, repo)
  return { dir, created: true }
}

/**
 * 移除一个 worktree（默认 --force，连同未提交改动一起清理）。dry-run 下不实际移除。
 * @returns {{dir:string, removed:boolean, dryRun?:boolean}}
 */
export function gitWorktreeRemove(repo = process.cwd(), dir, { force = true } = {}) {
  if (!dir) throw new Error('gitWorktreeRemove 需要 dir')
  if (isDryRun()) return { dir, removed: false, dryRun: true }
  const args = ['worktree', 'remove', dir]
  if (force) args.push('--force')
  git(args, repo)
  return { dir, removed: true }
}
