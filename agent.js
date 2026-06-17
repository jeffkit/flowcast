// agent.js — CLI adapter 层
//
// 职责拆分：
//   spawn.js       — 底层进程原语（spawnCapture / spawnCli / isProviderRetryable / sweepStaleTmp）
//   concurrency.js — 并发工具（parallel / pipeline）
//   hitl.js        — HITL 子系统（setHitlBackend / waitForInput / notify …）
//   agent.js（本文件）— CLI adapter（claude/cursor/…/recursive）+ 可观测事件 sink
//   executor.js    — runAgent 路由 + runAgentChain 回退链 + EXECUTORS 注册表
//
// 所有曾从 agent.js 导出的符号仍从本文件导出（re-export），保持公共 API 不变。
// runAgent / runAgentChain / setWorkdir / AGENT_COOLDOWN_* 已迁至 executor.js，
// 本文件通过静态 re-export 将其重新暴露，消除了此前的 dynamic import 循环依赖。

import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnCapture, spawnCli, isProviderRetryable } from './spawn.js'
import { parallel, pipeline } from './concurrency.js'
import { setHitlBackend, getHitlBackend, waitForInput, notify } from './hitl.js'

// re-export 供外部从 agent.js 或 index.js 使用（保持 API 稳定）
export { spawnCapture, spawnCli, isProviderRetryable }
export { parallel, pipeline }
export { setHitlBackend, getHitlBackend, waitForInput, notify }

// ── provider 翻译器（claude adapter）────────────────────────────────

/**
 * claude adapter 的 provider 翻译器：把 provider bundle 翻译成 claude CLI 读的 env。
 * executor.js 的 EXECUTORS.claude.applyProvider 也指向这里（单一实现）。
 */
export function claudeProviderEnv(provider) {
  if (!provider) return undefined
  const env = {}
  if (provider.apiBase) env.ANTHROPIC_BASE_URL = provider.apiBase
  if (provider.apiKey) env.ANTHROPIC_AUTH_TOKEN = provider.apiKey
  return Object.keys(env).length ? env : undefined
}

export function claudeApplyProvider(bundle) {
  const env = claudeProviderEnv(bundle)
  return { env, model: bundle?.model }
}

// ── 观测事件 sink ────────────────────────────────────────────────────

let _agentEventSink = null

/** 注入 agent 观测事件回调（fallback 等）。传非函数即清空。 */
export function setAgentEventSink(fn) {
  _agentEventSink = typeof fn === 'function' ? fn : null
}

// executor.js 的 runAgentChain 需要 emitAgentEvent 发送 CLI fallback 事件；
// 导出为内部工具（不进 index.js 公共 API），executor.js 静态 import 以消除循环依赖。
export function emitAgentEvent(e) {
  if (!_agentEventSink) return
  try { _agentEventSink(e) } catch { /* 观测失败不影响主流程 */ }
}

// ── CLI adapter：claude ──────────────────────────────────────────────

async function claudeOnce(prompt, { cwd, effModel, extraArgs, timeout, env }) {
  const args = ['-p', prompt, '--output-format', 'json']
  if (effModel) args.push('--model', effModel)
  args.push(...extraArgs)
  const { stdout, exitCode, timedOut, spawnError } = await spawnCapture('claude', args, { cwd, timeout, env })
  if (spawnError) throw new Error(`[claude] spawn error: ${spawnError}`)
  if (timedOut) { const err = new Error(`[claude] timeout after ${timeout}ms`); err.timedOut = true; throw err }
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    if (exitCode !== 0) throw new Error(`[claude] exit ${exitCode}\n${stdout.trim()}`)
    console.warn(`[claude] warn: output is not JSON (exit 0), falling back to raw stdout — check claude CLI version`)
    return stdout.trim()
  }
  const item = Array.isArray(data) ? data.find(x => x.type === 'result') : data
  if (item?.is_error) {
    const err = new Error(`claude error: ${item.result}`)
    err.apiStatus = item.api_error_status
    throw err
  }
  const usage = item?.usage ?? {}
  const result = item?.result ?? stdout.trim()
  return Object.assign(String(result), {
    _meta: { cli: 'claude', model: item?.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  })
}

/**
 * Claude Code CLI  (claude -p ...)
 * provider（可选）：anthropic 兼容网关 bundle。
 * providerFallbacks（可选）：主 provider 限额/超载时按序回退的 bundle 列表。
 */
export async function claude(prompt, {
  cwd = process.cwd(), model, timeout = 300_000, extraArgs = [], provider, providerFallbacks = [],
} = {}) {
  const chain = [provider, ...providerFallbacks].filter(p => p != null)
  if (chain.length === 0) chain.push(undefined)
  let lastErr
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]
    try {
      return await claudeOnce(prompt, { cwd, effModel: model ?? p?.model, extraArgs, timeout, env: claudeProviderEnv(p) })
    } catch (e) {
      lastErr = e
      if (i < chain.length - 1 && isProviderRetryable(e)) {
        const from = p?.name ?? 'default'
        const to = chain[i + 1]?.name ?? 'default'
        const reason = String(e.apiStatus ?? e.message).slice(0, 80)
        console.warn(`  [provider fallback] ${from} 不可用（${reason}），切换 → ${to}`)
        emitAgentEvent({ event: 'fallback', scope: 'provider', cli: 'claude', from, to, reason })
        continue
      }
      throw e
    }
  }
  throw lastErr
}

// ── CLI adapter：gemini ──────────────────────────────────────────────

/** Gemini CLI  (gemini -p ...) */
export async function gemini(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('gemini', args, cwd, timeout)
  return raw.trim()
}

// ── CLI adapter：codex ───────────────────────────────────────────────

/** Codex CLI  (codex exec ...) */
export async function codex(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const outFile = join(tmpdir(), `flowcast-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile]
  if (model) args.push('--model', model)
  args.push(...extraArgs, prompt)
  const raw = await spawnCli('codex', args, cwd, timeout)
  try {
    if (existsSync(outFile)) {
      const msg = readFileSync(outFile, 'utf8').trim()
      unlinkSync(outFile)
      if (msg) return msg
    }
  } catch { /* 读临时文件失败则回退 stdout */ }
  return raw.trim()
}

// ── CLI adapter：agy ─────────────────────────────────────────────────

/** agy CLI  (agy -p ...) */
export async function agy(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('agy', args, cwd, timeout)
  return raw.trim()
}

// ── CLI adapter：aider ───────────────────────────────────────────────

/** Aider  (aider --message ...) */
export async function aider(prompt, { cwd = process.cwd(), model, files = [], timeout = 600_000, extraArgs = [] } = {}) {
  const args = ['--message', prompt, '--yes-always', '--no-pretty']
  if (model) args.push('--model', model)
  args.push(...files, ...extraArgs)
  const raw = await spawnCli('aider', args, cwd, timeout)
  return raw.trim()
}

// ── CLI adapter：cursor ──────────────────────────────────────────────

/** Cursor Agent CLI  (agent -p ...) */
export async function cursor(prompt, { cwd = process.cwd(), timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt, '--output-format', 'json', ...extraArgs]
  const raw = await spawnCli('agent', args, cwd, timeout)
  try {
    const data = JSON.parse(raw)
    if (data.is_error) throw new Error(`cursor agent error: ${data.result}`)
    const result = data.result ?? raw.trim()
    return Object.assign(String(result), {
      _meta: { cli: 'cursor', inputTokens: data.usage?.inputTokens, outputTokens: data.usage?.outputTokens }
    })
  } catch (e) {
    if (e.message.startsWith('cursor agent error:')) throw e
    return raw.trim()
  }
}

// ── CLI adapter：recursive ───────────────────────────────────────────
//
// recursive 的 exit code 是数据（0=正常、1=失败、101=panic、BudgetExceeded 也非零）。
// 用 spawnCapture 不抛错，把 exit code / finishReason / budgetExceeded 全放进 _meta。

/** 解析 recursive 二进制路径：优先 release，其次 debug，最后 PATH 上的 recursive。 */
export function resolveRecursiveBin(cwd = process.cwd()) {
  for (const p of ['target/release/recursive', 'target/debug/recursive']) {
    if (existsSync(join(cwd, p))) return join(cwd, p)
  }
  return 'recursive'
}

/**
 * recursive 执行器。
 * @returns {Promise<String & {_meta}>}
 */
export async function recursive(goal, {
  cwd = process.cwd(),
  bin,
  workspace = '.',
  systemPromptFile,
  transcriptOut,
  pricingFile,
  provider,
  model,
  apiKey,
  apiBase,
  maxSteps,
  log = 'warn',
  allowTools,
  replayFrom,
  env,
  timeout = 1_800_000,
  onData,
} = {}) {
  const resolvedBin = bin ?? resolveRecursiveBin(cwd)
  const args = ['--workspace', workspace]
  if (systemPromptFile) args.push('--system-prompt-file', systemPromptFile)
  if (transcriptOut) args.push('--transcript-out', transcriptOut)
  if (pricingFile) args.push('--pricing-file', pricingFile)
  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
  // apiKey/apiBase 通过 env 注入，避免明文出现在 argv（ps aux 可见）
  if (apiKey || apiBase) env = { ...recursiveProviderEnv({ apiBase, apiKey }), ...env }
  if (maxSteps) args.push('--max-steps', String(maxSteps))
  if (log) args.push('--log', log)
  if (allowTools) args.push('--allow-tools', allowTools)
  if (replayFrom) {
    args.push('replay', replayFrom.transcript, '--resume-from', String(replayFrom.resumeFrom), goal)
  } else {
    args.push('run', goal)
  }

  const { stdout, exitCode, timedOut, spawnError } = await spawnCapture(resolvedBin, args, { cwd, timeout, env, onData })

  const budgetExceeded = /reason:\s*BudgetExceeded/.test(stdout)
  const finishMatch = stdout.match(/\[done after \d+ steps\]\s*reason:\s*(.+)/)
  const finishReason = finishMatch ? finishMatch[1].trim() : null
  const panicked = exitCode === 101 || (typeof exitCode === 'number' && exitCode >= 128)

  let transcriptMessages = 0
  if (transcriptOut && existsSync(transcriptOut)) {
    try {
      transcriptMessages = JSON.parse(readFileSync(transcriptOut, 'utf8')).messages?.length ?? 0
    } catch { /* transcript 可能未写完 */ }
  }

  return Object.assign(String(stdout), {
    _meta: { cli: 'recursive', exitCode, timedOut, spawnError, budgetExceeded, finishReason, panicked, transcriptMessages },
  })
}

/**
 * 把通用 provider bundle 翻译成 recursive 二进制读取的 RECURSIVE_* 环境变量。
 */
export function recursiveProviderEnv({ type, apiBase, model, apiKey, maxSteps } = {}) {
  const env = {}
  if (type) env.RECURSIVE_PROVIDER_TYPE = type
  if (apiBase) env.RECURSIVE_API_BASE = apiBase
  if (model) env.RECURSIVE_MODEL = model
  if (apiKey) env.RECURSIVE_API_KEY = apiKey
  if (maxSteps != null && maxSteps !== '') env.RECURSIVE_MAX_STEPS = String(maxSteps)
  return env
}

// ── re-export 路由层（已迁至 executor.js）───────────────────────────
//
// runAgent / runAgentChain / setWorkdir / AGENT_COOLDOWN_* 的实现在 executor.js；
// 由 executor.js 直接访问 EXECUTORS，无需 dynamic import，循环依赖已消除。
// 此处静态 re-export 保持公共 API 不变（index.js 及现有调用方无需修改）。
export { runAgent, runAgentChain, setWorkdir, AGENT_COOLDOWN_BASE_MS, AGENT_COOLDOWN_MAX_MS } from './executor.js'
