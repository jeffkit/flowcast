// git.js — 生成的 flow 可用的 git 原语（从 @force-lab/flowx 暴露，绕开 child_process 白名单）
//
// 生成的 flow 受 import 白名单约束（不能直接用 child_process），但常需要 git commit/diff。
// 通过 flowx 暴露这组受控 helper，让编排逻辑提交改动而无需裸调 shell。

import { execFileSync } from 'child_process'
import { isDryRun } from './dry-run.js'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 工作树改动（porcelain）。 */
export function gitStatus(repo = process.cwd()) {
  return git(['status', '--porcelain'], repo)
}

/** diff（默认未暂存；staged=true 看已暂存）。 */
export function gitDiff(repo = process.cwd(), { staged = false } = {}) {
  return git(staged ? ['diff', '--cached'] : ['diff'], repo)
}

/**
 * 暂存全部并提交；无改动则跳过。dry-run 下不实际提交。
 * @returns {{committed:boolean, sha?:string, dryRun?:boolean, reason?:string}}
 */
export function gitCommitAll(repo = process.cwd(), message = 'flowx: automated commit') {
  if (isDryRun()) return { committed: false, dryRun: true }
  git(['add', '-A'], repo)
  if (!git(['status', '--porcelain'], repo)) return { committed: false, reason: 'nothing to commit' }
  git(['commit', '-m', message], repo)
  return { committed: true, sha: git(['rev-parse', 'HEAD'], repo) }
}
