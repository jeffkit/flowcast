// orchestrator/run.js — 执行生成的 flow（护栏③：子进程隔离 + 续跑锁定）

import { spawn } from 'child_process'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateFlow } from './generate.js'

/**
 * 子进程隔离跑一个 flow 文件（`node <file> ...`）。隔离 + 超时可控 + 崩溃不污染宿主。
 * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, spawnError?:boolean}>}
 */
export function runGeneratedFlow(file, {
  repo, runId, goal, agent, extraArgs = [], dryRun = false, timeout, cwd = repo, onData,
} = {}) {
  return new Promise((resolve) => {
    const args = [file]
    if (runId) args.push('--run-id', runId)
    if (repo) args.push('--repo', repo)
    if (goal != null) args.push('--goal', goal)
    if (agent) args.push('--agent', agent)
    if (dryRun) args.push('--dry-run')
    args.push(...extraArgs)

    const env = { ...process.env }
    if (dryRun) env.FLOWX_DRY_RUN = '1'

    const proc = spawn('node', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d; onData?.(String(d)) })
    proc.stderr.on('data', d => { stderr += d; onData?.(String(d)) })

    let timer
    if (timeout) timer = setTimeout(() => proc.kill('SIGKILL'), timeout)
    proc.on('close', code => { if (timer) clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }) })
    proc.on('error', err => { if (timer) clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: stderr + String(err), spawnError: true }) })
  })
}

/**
 * 端到端编排：需求 →（生成 or 复用）→ 执行。
 * **续跑锁定**：run 目录已有 flow.mjs 则直接跑同一份，绝不重生成（保 resume 语义）。
 *
 * @param {string} request
 * @param {object} o  repo / runId / agent / agents / providers / generate / dryRun / timeout / onData
 * @returns {Promise<object>} { ok, stage, file, reused, attempts, exitCode, stdout, stderr }
 */
export async function orchestrate(request, {
  repo = process.cwd(), runId = `orch-${Date.now()}`,
  agent, agents = {}, providers = {}, generate,
  dryRun = false, timeout, onData,
} = {}) {
  const runDir = join(repo, '.flowx', 'runs', runId)
  const file = join(runDir, 'flow.mjs')
  let reused = false
  let attempts = 0

  if (existsSync(file)) {
    reused = true // 续跑锁定
  } else {
    const g = await generateFlow(request, { repo, runDir, agent, agents, providers, generate })
    attempts = g.attempts
    if (!g.validation.ok) return { ok: false, stage: 'generate', error: g.validation.error, file, attempts }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'request.txt'), request, 'utf8')
  }

  const res = await runGeneratedFlow(file, { repo, runId, goal: request, agent, dryRun, timeout, cwd: repo, onData })
  return { ok: res.exitCode === 0, stage: 'run', file, reused, attempts, ...res }
}
