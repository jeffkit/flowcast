// executor/agentproc-adapter.js — flowcast ↔ agentproc 翻译层
//
// 把 flowcast 内部的「执行器概念」映射到 agentproc SDK 的 in-process executor：
//   - flowcast 的 cli 名（'claude' / 'codex' / 'agy' …）→ agentproc executor 名（'claude-code' / 'codex' / 'agy' …）
//   - flowcast opts（cwd / timeout / env / provider / extraArgs）→ agentproc profile + RunOptions
//   - agentproc RunResult → flowcast 的 makeAgentResult（保持 String & {text, _meta} 契约）
//
// 设计要点：
//   - 不引入任何 per-CLI 适配代码——所有 buildArgs / parseEvent 由 agentproc SDK 提供
//   - agentproc 的 `runViaExecutor` 直接 spawn CLI 二进制（单 fork），不走 bridge 子进程
//   - dry-run 路径不被翻译层拦截，仍由 resolveAgent 的 makeFakeRun 处理
//   - recursive CLI 的特殊 _meta（budgetExceeded / panicked）由同目录的 recursive-extras.js 处理

import agentproc from 'agentproc'
// agentproc v0.10.0 的 index.js 没 re-export run()——它在 runner.js 里。
// 直接 require agentproc's runner to access run(). ESM 兼容 via createRequire。
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
const { run: agentprocRun } = _require('agentproc/src/runner.js')

import { makeAgentResult, makeEvent } from '../helpers.js'
import { EVENT } from '../events.js'
import { FlowcastError, TimeoutError, SpawnError, ConfigError } from '../errors.js'

// ── cli → executor 名称映射 ────────────────────────────────────────────
//
// flowcast 历史 CLI 名跟 agentproc executor 名不完全对齐（flowcast 'claude' 对应 agentproc 'claude-code'）。
// 这张表是「flowcast 用户视角」的 CLI 名，与「agentproc SDK 内部」的 executor 名之间的桥梁。
//
// 重要：`recursive` 在 agentproc v0.10.0 SDK 的 EXECUTORS 表中**没有条目**（它的 hub bridge
// 有自定义 run loop，不符合 agentproc 的通用 buildArgs/parseEvent 模式）。所以 recursive 在本表
// 里映射为 null——flowcast 走自己的路径（直接 spawn recursive 二进制 + recursive-extras 后处理）。
//
// 锁定型 cursor/gemini/codex/agy 在 agentproc 里有同名 executor；
// BYO-LLM 的 claude/aider 同理（recursive 单独处理）。
// 新接入的 pi/opencode/kimi-code/deepseek/qwen-code 直接用同名。

export const CLI_TO_EXECUTOR = Object.freeze({
  claude:    'claude-code',
  cursor:    'cursor',
  agent:     'cursor',          // 历史别名：cursor 二进制叫 `agent`
  gemini:    'gemini-cli',
  codex:     'codex',
  agy:       'agy',
  aider:     'aider',
  recursive: null,              // agentproc SDK 没收录；走 flowcast 自己的路径
  pi:        'pi',
  opencode:  'opencode',
  'kimi-code': 'kimi-code',
  deepseek:  'deepseek',
  'qwen-code': 'qwen-code',
  codebuddy: 'codebuddy',
})

/**
 * flowcast CLI 名 → agentproc executor 名。
 *
 * @param {string} cli
 * @returns {string|null}  null = agentproc SDK 不收录此 CLI（如 recursive），caller 走 flowcast 自己的路径
 * @throws {ConfigError}  未知名抛错（带已知列表）
 */
export function cliToExecutorName(cli) {
  if (!(cli in CLI_TO_EXECUTOR)) {
    const known = Object.keys(CLI_TO_EXECUTOR).join(' / ')
    throw new ConfigError(`未知执行器 '${cli}'（已知：${known}）`)
  }
  return CLI_TO_EXECUTOR[cli]
}

// ── profile → agentproc profile ────────────────────────────────────────
//
// flowcast 内部传的「opts」结构（camelCase、混合白名单字段、env 来自 provider 翻译）
// 转成 agentproc 期望的 profile（snake_case、env_allowlist、timeout_secs、streaming）。
//
// 注意：agentproc profile 的字段集合跟 flowcast opts 不完全重合——我们只填它认得的字段。

const TIMEOUT_KEYS = {
  claude:    'FLOWCAST_CLAUDE_TIMEOUT_MS',
  gemini:    'FLOWCAST_GEMINI_TIMEOUT_MS',
  codex:     'FLOWCAST_CODEX_TIMEOUT_MS',
  agy:       'FLOWCAST_AGY_TIMEOUT_MS',
  cursor:    'FLOWCAST_CURSOR_TIMEOUT_MS',
  agent:     'FLOWCAST_CURSOR_TIMEOUT_MS',
  aider:     'FLOWCAST_AIDER_TIMEOUT_MS',
  recursive: 'FLOWCAST_RECURSIVE_TIMEOUT_MS',
}

const DEFAULT_TIMEOUT_MS = {
  claude: 300_000, gemini: 300_000, codex: 300_000, agy: 300_000,
  cursor: 300_000, aider: 600_000, recursive: 1_800_000,
}

/**
 * 给定 flowcast 的执行上下文，构造 agentproc profile 对象。
 *
 * @param {object} ctx
 * @param {string} ctx.cli              flowcast CLI 名（如 'claude'）
 * @param {string} [ctx.cwd]
 * @param {number} [ctx.timeout]        ms
 * @param {object} [ctx.env]            来自 provider 翻译的 env（已合并）
 * @param {object} [ctx.extraEnv]       调用方临时 env override
 * @param {string[]} [ctx.envAllowlist] agentproc 的 env_allowlist（白名单内变量允许 ${VAR} 展开）
 * @param {boolean} [ctx.streaming]     默认 true
 * @returns {object} agentproc profile
 */
export function buildAgentProcProfile(ctx) {
  const cli = ctx.cli
  const executor = cliToExecutorName(cli)
  if (executor === null) {
    // flowcast 自己处理（如 recursive）；executor.js 的 makeDefaultRun 会走特殊路径
    return null
  }
  const profile = {
    executor,
    timeout_secs: Math.ceil((ctx.timeout ?? DEFAULT_TIMEOUT_MS[cli] ?? 300_000) / 1000),
    streaming: ctx.streaming !== false,
    permission: false,
    env: {},
  }
  if (ctx.cwd) profile.cwd = ctx.cwd
  if (ctx.env && Object.keys(ctx.env).length) {
    profile.env = { ...ctx.env }
  }
  if (ctx.extraEnv && Object.keys(ctx.extraEnv).length) {
    profile.env = { ...profile.env, ...ctx.extraEnv }
  }
  if (Array.isArray(ctx.envAllowlist) && ctx.envAllowlist.length) {
    profile.env_allowlist = ctx.envAllowlist
  }
  return profile
}

// ── opts → agentproc RunOptions ────────────────────────────────────────

/**
 * 把 flowcast opts 转成 agentproc RunOptions（message / sessionId / cwd / callbacks 等）。
 * sessionId 用于跨 turn 续接；flowcast 没有 session 概念时传空字符串。
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} [opts.sessionId]
 * @param {number} [opts.timeoutSecs]
 * @param {boolean} [opts.streaming]
 * @param {Function} [opts.onPartial]    流式回调 (text: string) => void
 * @param {Function} [opts.onError]      错误回调 (msg: string) => void
 * @param {Function} [opts.onSession]    session id 捕获回调 (sid: string) => void
 * @param {Function} [opts.onStderr]     stderr 行回调 (line: string) => void
 * @param {Function} [opts.onProtocolLine] 协议行回调（debug）
 * @param {object} [opts.extraEnv]       临时 env override
 * @param {Function} [opts.onFallback]   agentproc 不可用时调用 (reason) => void（用于 emit FALLBACK event）
 * @returns {object} agentproc RunOptions
 */
export function buildAgentProcOptions(prompt, opts = {}) {
  const ap = {
    message: String(prompt ?? ''),
    sessionId: opts.sessionId || '',
    sessionName: opts.sessionName || 'default',
    fromUser: opts.fromUser || '',
  }
  if (opts.cwd) ap.cwd = opts.cwd
  if (opts.timeoutSecs != null) ap.timeoutSecs = opts.timeoutSecs
  if (opts.streaming != null) ap.streaming = opts.streaming
  if (typeof opts.onPartial === 'function') ap.onPartial = opts.onPartial
  if (typeof opts.onError === 'function') ap.onError = opts.onError
  if (typeof opts.onSession === 'function') ap.onSession = opts.onSession
  if (typeof opts.onStderr === 'function') ap.onStderr = opts.onStderr
  if (typeof opts.onProtocolLine === 'function') ap.onProtocolLine = opts.onProtocolLine
  if (opts.extraEnv) ap.extraEnv = opts.extraEnv
  return ap
}

// ── RunResult → makeAgentResult ────────────────────────────────────────

/**
 * 把 agentproc RunResult 翻译成 flowcast 的 makeAgentResult（保持 String & {text, _meta} 契约）。
 *
 * agentproc 不抛错——失败信息放在 RunResult.error/exitCode 上。我们翻译时把
 * 真正的失败（error 非空或非零 exit）转成对应的 FlowcastError 子类抛出，
 * 让 runAgentChain 的 isProviderRetryable 链路正常工作。
 *
 * @param {object} runResult    agentproc 返回值
 * @param {string} cli          flowcast CLI 名（仅用于 _meta 标记）
 * @param {string} executor     agentproc executor 名（用于 _meta）
 * @returns {String & {text, _meta}}
 */
export function resultToAgentResult(runResult, cli, executor) {
  if (!runResult || typeof runResult !== 'object') {
    throw new FlowcastError('agentproc run 返回无效结果', 'AGENTPROC_INVALID_RESULT')
  }

  // ── 失败路径 → 抛 FlowcastError ──────────────────────────────────────
  // agentproc 把 spawn 失败 / 非零退出 / error event 都放在 result.error 上。
  // 翻译成 flowcast 错误体系：spawn 失败 → SpawnError；超时 → TimeoutError；其余 → FlowcastError。
  if (runResult.error) {
    const meta = {
      cli,
      executor,
      exitCode: runResult.exitCode ?? -1,
      timedOut: !!runResult.timedOut,
      sessionId: runResult.sessionId || undefined,
      output: runResult.reply || '',
    }
    if (runResult.timedOut) {
      throw new TimeoutError(`[${cli}] ${runResult.error}`, { _meta: meta })
    }
    // agentproc 在 ENOENT 时返回 exitCode=1 + error 含 "CLI not found"
    if (/\bnot found\b|ENOENT/i.test(runResult.error)) {
      throw new SpawnError(`[${cli}] ${runResult.error}`, runResult.error, { _meta: meta })
    }
    throw new FlowcastError(`[${cli}] ${runResult.error}`, 'AGENT_FAIL', { _meta: meta })
  }

  // ── 成功路径 → makeAgentResult ──────────────────────────────────────
  const meta = {
    cli,
    executor,
    sessionId: runResult.sessionId || undefined,
    exitCode: runResult.exitCode ?? 0,
    timedOut: !!runResult.timedOut,
  }
  // usage：opaque pass-through（agentproc 已透传 CLI 上报的 token / cache / duration / cost）
  if (runResult.usage && typeof runResult.usage === 'object') {
    meta.usage = runResult.usage
    // 顺手把常用字段提到 _meta 一级，便于下游 checkpoint.pickAgentMeta 拾取
    if (typeof runResult.usage.input_tokens === 'number')  meta.inputTokens  = runResult.usage.input_tokens
    if (typeof runResult.usage.output_tokens === 'number') meta.outputTokens = runResult.usage.output_tokens
  }
  return makeAgentResult(runResult.reply || '', meta)
}

// ── agentproc 入口 ─────────────────────────────────────────────────────
//
// 对外只暴露一个 runAgentProcRun(prompt, ctx, opts)，封装 buildAgentProcProfile + buildAgentProcOptions + agentproc.run + resultToAgentResult。
// executor.js 的 runAgent 调它即可。

/**
 * 跑一次 agent，agentproc SDK 后端。
 *
 * 对于 agentproc SDK EXECUTORS 表里**没有收录**的 CLI（如 recursive），buildAgentProcProfile
 * 返回 null——此函数返回特殊 sentinel `{__flowcastPath: true}` 让 caller（executor.js 的
 * makeDefaultRun）走 flowcast 自己的路径（spawnCapture + recursive-extras 等）。
 *
 * @param {string} prompt
 * @param {object} ctx
 * @param {object} [opts]
 * @returns {Promise<String & {text, _meta}>|{__flowcastPath: true}}
 */
export async function runViaAgentProc(prompt, ctx, opts = {}) {
  const profile = buildAgentProcProfile(ctx)
  if (profile === null) {
    return { __flowcastPath: true, ctx, opts, prompt }
  }
  const apOpts = buildAgentProcOptions(prompt, opts)
  const runResult = await agentprocRun(profile, apOpts)
  return resultToAgentResult(runResult, ctx.cli, profile.executor)
}

// ── 列举当前 SDK 已知的所有 executor 名（用于 runAgent / registerExecutor 错误信息）────

export const KNOWN_EXECUTORS = agentproc.executorNames