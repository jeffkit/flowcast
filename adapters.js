// adapters.js — CLI adapter 函数集合（claude/cursor/gemini/codex/aider/recursive/agy）
//
// 从 agent.js 提取，消除 agent.js ↔ executor.js 静态 ESM 循环依赖：
//   旧：executor.js ←imports adapters← agent.js ←re-exports← executor.js（循环）
//   新：executor.js ←imports← adapters.js（无循环）
//       agent.js   ←imports← adapters.js + re-exports executor.js（无循环）
//
// 本文件只依赖叶子模块（spawn.js / concurrency.js / hitl.js），不依赖 executor.js，
// 因此不存在循环。

import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnCapture, spawnCli, isProviderRetryable } from './spawn.js'
import { TimeoutError, SpawnError, FlowcastError } from './errors.js'
import { makeEvent } from './helpers.js'

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
  if (provider.extraEnv && typeof provider.extraEnv === 'object') {
    Object.assign(env, provider.extraEnv)
  }
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
// 从本文件导出，executor.js 直接 import（消除循环依赖的关键）。
// makeEvent 统一事件格式：外部已有 event 字段的对象直接透传，否则用 type 包装。
export function emitAgentEvent(e) {
  if (!_agentEventSink) return
  const normalized = (e && e.event) ? e : makeEvent(e?.type ?? 'agent', e ?? {})
  try { _agentEventSink(normalized) } catch { /* 观测失败不影响主流程 */ }
}

// ── 默认超时常量 ─────────────────────────────────────────────────────

function envTimeoutMs(envKey, fallback) {
  const v = parseInt(process.env[envKey] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export const CLAUDE_DEFAULT_TIMEOUT   = envTimeoutMs('FLOWCAST_CLAUDE_TIMEOUT_MS',     300_000)
export const GEMINI_DEFAULT_TIMEOUT   = envTimeoutMs('FLOWCAST_GEMINI_TIMEOUT_MS',     300_000)
export const CODEX_DEFAULT_TIMEOUT    = envTimeoutMs('FLOWCAST_CODEX_TIMEOUT_MS',      300_000)
export const AGY_DEFAULT_TIMEOUT      = envTimeoutMs('FLOWCAST_AGY_TIMEOUT_MS',        300_000)
export const CURSOR_DEFAULT_TIMEOUT   = envTimeoutMs('FLOWCAST_CURSOR_TIMEOUT_MS',     300_000)
export const AIDER_DEFAULT_TIMEOUT    = envTimeoutMs('FLOWCAST_AIDER_TIMEOUT_MS',      600_000)
export const RECURSIVE_DEFAULT_TIMEOUT = envTimeoutMs('FLOWCAST_RECURSIVE_TIMEOUT_MS', 1_800_000)

// ── CLI adapter：claude ──────────────────────────────────────────────

async function claudeOnce(prompt, { cwd, effModel, extraArgs, timeout, env }) {
  const args = ['-p', prompt, '--output-format', 'json']
  if (effModel) args.push('--model', effModel)
  args.push(...extraArgs)
  const { stdout, exitCode, timedOut, spawnError } = await spawnCapture('claude', args, { cwd, timeout, env })
  if (spawnError) throw new SpawnError('[claude] spawn error', spawnError)
  if (timedOut) throw new TimeoutError(`[claude] timeout after ${timeout}ms`)
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    if (exitCode !== 0) throw new SpawnError('[claude]', null, { exitCode, output: stdout.trim() })
    console.warn(`[claude] warn: output is not JSON (exit 0), falling back to raw stdout — check claude CLI version`)
    return Object.assign(String(stdout.trim()), { _meta: { cli: 'claude' } })
  }
  const item = Array.isArray(data) ? data.find(x => x.type === 'result') : data
  if (item?.is_error) {
    // 保留普通 Error 以供 isRetryable 识别 apiStatus 字段（不能换为 SpawnError）
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
 */
export async function claude(prompt, {
  cwd = process.cwd(), model, timeout = CLAUDE_DEFAULT_TIMEOUT, extraArgs = [], provider, providerFallbacks = [],
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
export async function gemini(prompt, { cwd = process.cwd(), model, timeout = GEMINI_DEFAULT_TIMEOUT, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('gemini', args, cwd, timeout)
  return Object.assign(String(raw.trim()), { _meta: { cli: 'gemini', model } })
}

// ── CLI adapter：codex ───────────────────────────────────────────────

/** Codex CLI  (codex exec ...) */
export async function codex(prompt, { cwd = process.cwd(), model, timeout = CODEX_DEFAULT_TIMEOUT, extraArgs = [] } = {}) {
  const outFile = join(tmpdir(), `flowcast-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile]
  if (model) args.push('--model', model)
  args.push(...extraArgs, prompt)
  try {
    const raw = await spawnCli('codex', args, cwd, timeout)
    let text = raw.trim()
    try {
      if (existsSync(outFile)) {
        const msg = readFileSync(outFile, 'utf8').trim()
        if (msg) text = msg
      }
    } catch { /* 读临时文件失败则回退 stdout */ }
    return Object.assign(String(text), { _meta: { cli: 'codex', model } })
  } finally {
    try { if (existsSync(outFile)) unlinkSync(outFile) } catch { /* 清理失败忽略 */ }
  }
}

// ── CLI adapter：agy ─────────────────────────────────────────────────

/** agy CLI  (agy -p ...) */
export async function agy(prompt, { cwd = process.cwd(), model, timeout = AGY_DEFAULT_TIMEOUT, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('agy', args, cwd, timeout)
  return Object.assign(String(raw.trim()), { _meta: { cli: 'agy', model } })
}

// ── CLI adapter：aider ───────────────────────────────────────────────

/** Aider  (aider --message ...) */
export async function aider(prompt, { cwd = process.cwd(), model, files = [], timeout = AIDER_DEFAULT_TIMEOUT, extraArgs = [] } = {}) {
  const args = ['--message', prompt, '--yes-always', '--no-pretty']
  if (model) args.push('--model', model)
  args.push(...files, ...extraArgs)
  const raw = await spawnCli('aider', args, cwd, timeout)
  return Object.assign(String(raw.trim()), { _meta: { cli: 'aider', model } })
}

// ── CLI adapter：cursor ──────────────────────────────────────────────

/** Cursor Agent CLI  (agent -p ...) */
export async function cursor(prompt, { cwd = process.cwd(), timeout = CURSOR_DEFAULT_TIMEOUT, extraArgs = [] } = {}) {
  const args = ['-p', prompt, '--output-format', 'json', ...extraArgs]
  const raw = await spawnCli('agent', args, cwd, timeout)
  try {
    const data = JSON.parse(raw)
    if (data.is_error) throw new SpawnError(`cursor agent error: ${data.result}`, null)
    const result = data.result ?? raw.trim()
    return Object.assign(String(result), {
      _meta: { cli: 'cursor', inputTokens: data.usage?.inputTokens, outputTokens: data.usage?.outputTokens }
    })
  } catch (e) {
    if (e instanceof SpawnError) throw e
    return Object.assign(String(raw.trim()), { _meta: { cli: 'cursor' } })
  }
}

// ── CLI adapter：recursive ───────────────────────────────────────────
//
// recursive 的 exit code 是数据（0=正常、1=失败、101=panic、BudgetExceeded 也非零）。
// 用 spawnCapture 不抛错，把 exit code / finishReason / budgetExceeded 全放进 _meta。
//
// P1-A3 修复：runAgent 层可通过 throwOnCritical=true 让严重失败（panicked/budgetExceeded）
// 抛出 FlowcastError，与其他 adapter 的失败行为保持一致，防止 runAgentChain 把失败当成功。

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
  timeout = RECURSIVE_DEFAULT_TIMEOUT,
  onData,
  throwOnCritical = false,  // P1-A3: true 时 panicked/budgetExceeded 抛 FlowcastError
} = {}) {
  const resolvedBin = bin ?? resolveRecursiveBin(cwd)
  const args = ['--workspace', workspace]
  if (systemPromptFile) args.push('--system-prompt-file', systemPromptFile)
  if (transcriptOut) args.push('--transcript-out', transcriptOut)
  if (pricingFile) args.push('--pricing-file', pricingFile)
  if (provider) args.push('--provider', provider)
  if (model) args.push('--model', model)
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

  const meta = { cli: 'recursive', exitCode, timedOut, spawnError, budgetExceeded, finishReason, panicked, transcriptMessages }

  // 严重失败时根据 throwOnCritical 决定是否抛错。
  // 抛 FlowcastError（code='RECURSIVE_FAIL'），接入统一错误体系：
  //   - isRetryable() 可正确识别（timedOut=true 时会重试）
  //   - runAgentChain 捕获后能走 provider fallback 路径
  //   - 与其他 adapter 的失败行为保持一致（之前是普通 Error，runAgentChain 无法正常处理）
  if (throwOnCritical && (panicked || budgetExceeded || exitCode !== 0)) {
    const reason = panicked ? 'panicked' : budgetExceeded ? 'BudgetExceeded' : `exit ${exitCode}`
    throw new FlowcastError(
      `[recursive] failed: ${reason}\n${stdout.slice(0, 500)}`,
      'RECURSIVE_FAIL',
      { _meta: meta, timedOut },  // timedOut=true 时 isRetryable 会识别为可回退
    )
  }

  return Object.assign(String(stdout), { _meta: meta })
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
