// orchestrator/validate.js — 生成 flow 的跑前校验（护栏②）
//
// 三关：① node --check 语法；② import 白名单（挡任意 fs/进程/网络）；③ 假执行器 dry-run。
// 本文件是 harness 受信代码，可用 child_process/fs；被校验的是「生成的 flow」，受白名单约束。

import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'

// 生成的 flow 只准 import flowx 包本身 + util（parseArgs）。
const IMPORT_WHITELIST = new Set(['@force-lab/flowx', 'util', 'node:util'])

/** 扫描源码里所有 import/require 目标，返回非白名单的去重列表。 */
export function scanImports(source) {
  const violations = []
  const patterns = [
    /\bimport\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'm'
    /\bimport\s*['"]([^'"]+)['"]/g,                  // import 'm'（副作用）
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // 动态 import('m') / require('m')
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source))) {
      if (!IMPORT_WHITELIST.has(m[1])) violations.push(m[1])
    }
  }
  return [...new Set(violations)]
}

/**
 * 校验一个生成的 flow 文件。
 * @param {string} file
 * @param {object} [o]
 * @param {number} [o.timeout]  dry-run 子进程超时 ms（默认 60s）
 * @param {string} [o.repo]     指定 dry-run 用的 repo（默认临时 git repo，校验后清理）
 * @param {string} [o.cwd]      node 进程 cwd（决定 @force-lab/flowx 解析；默认 flowx 仓）
 * @returns {Promise<{ok:boolean, checks:string[], error?:string}>}
 */
export async function validateFlow(file, { timeout = 60_000, repo, cwd } = {}) {
  const checks = []
  const fail = (stage, msg) => ({ ok: false, checks, error: `[${stage}] ${msg}` })

  // ① 语法（生成的 flow 恒为 ESM；node --check 对无 package.json 的 .js 按 CJS 判定过松，
  //    故复制成 .mjs 再 --check，确保按 ESM 语法校验）
  const checkDir = mkdtempSync(join(tmpdir(), 'flowx-check-'))
  const checkFile = join(checkDir, 'flow.mjs')
  try {
    copyFileSync(file, checkFile)
    execFileSync('node', ['--check', checkFile], { stdio: 'pipe' })
    checks.push('syntax')
  } catch (e) {
    return (rmSync(checkDir, { recursive: true, force: true }), fail('syntax', String(e.stderr ?? e.message).trim()))
  }
  rmSync(checkDir, { recursive: true, force: true })

  // ② import 白名单
  const bad = scanImports(readFileSync(file, 'utf8'))
  if (bad.length) return fail('imports', `非白名单 import：${bad.join(', ')}（仅允许 @force-lab/flowx, util）`)
  checks.push('imports')

  // ③ 假执行器 dry-run（一次性 git repo）
  const tmp = repo ?? mkdtempSync(join(tmpdir(), 'flowx-dryrun-'))
  const cleanup = () => { if (!repo) rmSync(tmp, { recursive: true, force: true }) }
  try {
    if (!repo) {
      execFileSync('git', ['init', '-q'], { cwd: tmp })
      execFileSync('git', ['config', 'user.email', 'dryrun@flowx'], { cwd: tmp })
      execFileSync('git', ['config', 'user.name', 'flowx-dryrun'], { cwd: tmp })
    }
    execFileSync('node', [file, '--dry-run', '--repo', tmp, '--goal', 'dry-run-demo', '--run-id', `dryrun-${Date.now()}`], {
      stdio: 'pipe',
      timeout,
      cwd,
      env: { ...process.env, FLOWX_DRY_RUN: '1' },
    })
    checks.push('dry-run')
  } catch (e) {
    return (cleanup(), fail('dry-run', String(e.stderr ?? e.stdout ?? e.message).trim().slice(0, 500)))
  }
  cleanup()
  return { ok: true, checks }
}
