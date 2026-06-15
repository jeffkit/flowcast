// agent.js — CLI adapter 层 + runAgent 路由
//
// 职责拆分后（重构说明）：
//   spawn.js       — 底层进程原语（spawnCapture / spawnCli / isProviderRetryable / sweepStaleTmp）
//   concurrency.js — 并发工具（parallel / pipeline）
//   hitl.js        — HITL 子系统（setHitlBackend / waitForInput / notify …）
//   agent.js（本文件）— CLI adapter（claude/cursor/…/recursive）+ runAgent 路由 + 全局状态
//
// 所有曾从 agent.js 导出的符号仍从本文件导出（re-export），保持公共 API 不变。
// 循环依赖说明：runAgent 需要 EXECUTORS（executor.js），executor.js 又 import agent.js。
// 目前用 dynamic import 规避（已注释），是已知技术债，待后续将 runAgent 迁至 executor.js。

import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isDryRun } from './dry-run.js'
import { runStructured, stubFromSchema } from './schema.js'
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

function emitAgentEvent(e) {
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

// ── runAgent 路由 ────────────────────────────────────────────────────

// 内置 CLI 映射（cursor-agent 二进制名就叫 agent，别名复用）
const CLI_MAP = { claude, gemini, codex, aider, cursor, recursive, agy, agent: cursor }

let _defaultCwd = process.cwd()

/** 设置全局默认工作目录，flow 启动时调用一次，之后所有 runAgent 自动继承。 */
export function setWorkdir(dir) {
  _defaultCwd = dir
}

/**
 * 跑一次 agent。
 * @param {string} prompt
 * @param {object} [o]
 *   - cli           执行器名（默认 'claude'）
 *   - cwd           工作目录
 *   - schema        可选 JSON Schema：强制 agent 返回结构化对象（不匹配回喂重试）
 *   - schemaRetries 不匹配重试次数（默认 1）
 *   - 其余透传给底层执行器 adapter
 */
export async function runAgent(prompt, { cli = 'claude', cwd, schema, schemaRetries = 1, ...opts } = {}) {
  if (isDryRun()) {
    if (schema) return stubFromSchema(schema)
    return Object.assign(`[dry-run] ${cli} 未真实执行`, { _meta: { cli, dryRun: true } })
  }
  let fn = CLI_MAP[cli]
  if (!fn) {
    // CLI_MAP 未命中时回退查 EXECUTORS（registerExecutor 注册的自定义执行器）。
    // dynamic import 规避 agent.js ↔ executor.js 初始化时序的循环依赖。
    // 已知技术债：后续将 runAgent 迁至 executor.js 后可消除此 dynamic import。
    const { EXECUTORS } = await import('./executor.js')
    fn = EXECUTORS[cli]?.run
  }
  if (!fn) throw new Error(`未知 CLI: ${cli}，支持：${Object.keys(CLI_MAP).join('/')}（或通过 registerExecutor 注册的自定义执行器）`)
  const runner = (p) => fn(p, { cwd: cwd ?? _defaultCwd, ...opts })
  if (schema) return runStructured(runner, prompt, { schema, retries: schemaRetries })
  return runner(prompt)
}

// ── runAgentChain：跨 CLI 链式回退 ──────────────────────────────────

function specLabel(spec = {}) {
  return `${spec.cli ?? 'claude'}${spec.provider?.name ? '/' + spec.provider.name : ''}`
}

export const AGENT_COOLDOWN_BASE_MS = 30_000
export const AGENT_COOLDOWN_MAX_MS = 480_000

function envMs(newName, oldName, fallback) {
  const v = parseInt(process.env[newName] ?? process.env[oldName] ?? '', 10)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
function defaultCooldownBaseMs() { return envMs('FLOWCAST_AGENT_COOLDOWN_BASE_MS', 'FLOWX_AGENT_COOLDOWN_BASE_MS', AGENT_COOLDOWN_BASE_MS) }
function defaultCooldownMaxMs() { return envMs('FLOWCAST_AGENT_COOLDOWN_MAX_MS', 'FLOWX_AGENT_COOLDOWN_MAX_MS', AGENT_COOLDOWN_MAX_MS) }

function backoffMs(fails, base = AGENT_COOLDOWN_BASE_MS, cap = AGENT_COOLDOWN_MAX_MS) {
  const ms = Math.min(base * 2 ** Math.max(0, fails - 1), cap)
  return Math.round(ms * (0.9 + Math.random() * 0.2))
}

function coolRemaining(cooldown, spec, now) {
  if (!cooldown) return 0
  const entry = cooldown.get(specLabel(spec))
  const until = entry && typeof entry === 'object' ? entry.until : entry
  return until && until > now ? until - now : 0
}

/**
 * 跨 CLI 的 agent 链式回退：按序尝试，因限额/超载/超时失败就切下一个。
 * 可选 run 级冷却：共享 cooldown Map，按指数退避降级到链尾。
 */
export async function runAgentChain(prompt, chain, {
  runner = runAgent, cooldown = null,
  cooldownBaseMs = defaultCooldownBaseMs(), cooldownMaxMs = defaultCooldownMaxMs(),
} = {}) {
  const list = Array.isArray(chain) && chain.length ? chain : [{}]
  const now = Date.now()
  const order = cooldown
    ? list.map((spec, i) => ({ spec, i, cool: coolRemaining(cooldown, spec, now) }))
        .sort((a, b) => (a.cool - b.cool) || (a.i - b.i)).map(x => x.spec)
    : list
  let lastErr
  for (let i = 0; i < order.length; i++) {
    const spec = order[i]
    try {
      const r = await runner(prompt, spec)
      if (cooldown) cooldown.delete(specLabel(spec))
      return r
    } catch (e) {
      lastErr = e
      if (isProviderRetryable(e)) {
        const from = specLabel(spec)
        const reason = e.timedOut ? 'timeout' : String(e.apiStatus ?? e.message).slice(0, 80)
        if (cooldown) {
          const prev = cooldown.get(from)
          const fails = (prev && typeof prev === 'object' ? prev.fails ?? 0 : 0) + 1
          cooldown.set(from, { until: Date.now() + backoffMs(fails, cooldownBaseMs, cooldownMaxMs), fails })
        }
        if (i < order.length - 1) {
          const to = specLabel(order[i + 1])
          console.warn(`  [agent fallback] ${from} 不可用（${reason}），切换 → ${to}`)
          emitAgentEvent({ event: 'fallback', scope: 'cli', from, to, reason })
          continue
        }
      }
      throw e
    }
  }
  // 不可达：最后 provider 失败已通过 throw e 退出
}
