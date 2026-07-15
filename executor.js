// executor.js — 执行器能力分层 + agent profile 绑定层
//
// v0.6 重构（基于 AgentProc v0.10.0 in-process executor）：
//   - 不再维护 per-CLI adapter（adapters.js 已删除）。
//   - EXECUTORS 注册表现在是「flowcast CLI 名 → agentproc executor 描述符」的映射；
//     实际 CLI 调用走 agentproc SDK 的 in-process executor（agentproc.runViaExecutor 路径）。
//   - 所有 buildArgs / parseEvent / env 翻译 / session_id 处理由 agentproc SDK 提供，
//     单一事实来源。
//
// 「执行器（怎么驱动一个 CLI/agent）」与「provider（用哪个 LLM）」仍然正交：
//   - BYO-LLM（recursive/aider/claude）：profile 可指定 provider，env 翻译在 provider.js
//   - 锁定型（cursor/gemini/codex/agy）：不接受外部 provider，用自带 model 选择
//
// acceptsProvider 由 CLI_TO_EXECUTOR 的能力决定（与 agentproc 那边对应 executor 的 flag 翻译对齐）。

import {
  runViaAgentProc, cliToExecutorName, CLI_TO_EXECUTOR, KNOWN_EXECUTORS,
} from './executor/agentproc-adapter.js'
import { maybeThrowRecursiveCritical } from './executor/recursive-extras.js'
import { isProviderRetryable } from './spawn.js'
import { recordRateLimit, getAvailableAt, makeKey } from './rate-limiter.js'
import {
  resolveProvider, loadMergedConfig, basenamesFor,
  applyProviderToProfile,
  claudeProviderEnv, recursiveProviderEnv, aiderProviderEnv,
} from './provider.js'
import { isDryRun } from './dry-run.js'
import { runStructured, stubFromSchema } from './schema.js'
import { FlowcastError, ConfigError, PathError, TimeoutError, SpawnError } from './errors.js'
import { assertSafeIdent, makeAgentResult, makeEvent } from './helpers.js'
import { EVENT } from './events.js'
import { normalize } from 'path'

// ── CLI → executor 映射（flowcast 视角） ───────────────────────────────
//
// 历史原因，flowcast CLI 名不一定等于 agentproc executor 名（如 'claude' → 'claude-code'）。
// EXECUTORS 注册表的每个 entry 携带：
//   - executorName: agentproc executor 名
//   - acceptsProvider: 派生自 CLI_TO_EXECUTOR 是否在 BYO-LLM 列表
//
// 单 fork：agentproc.runViaExecutor 直接 spawn CLI 二进制，不走 bridge 子进程。

const BYO_LLM_CLIS = new Set(['claude', 'recursive', 'aider'])

function buildExecutorEntry(flowcastCli) {
  const executorName = CLI_TO_EXECUTOR[flowcastCli]
  if (!executorName) {
    return null
  }
  return {
    executorName,
    acceptsProvider: BYO_LLM_CLIS.has(flowcastCli),
  }
}

function buildBuiltinExecutors() {
  const entries = {}
  for (const cli of Object.keys(CLI_TO_EXECUTOR)) {
    const entry = buildExecutorEntry(cli)
    if (entry) {
      entries[cli] = entry
    } else {
      // agentproc SDK 不收录（如 recursive）；保留 cli 名作为「flowcast 内部处理」标记
      entries[cli] = { executorName: null, acceptsProvider: BYO_LLM_CLIS.has(cli) }
    }
  }
  return entries
}

/**
 * 执行器注册表：flowcast CLI 名 → {executorName, acceptsProvider, run?}。
 *
 * - 内置 entry 由 CLI_TO_EXECUTOR + agentproc SDK 派生（无 run，因为实际调用走 agentproc）。
 * - registerExecutor() 允许注入自定义 entry（含 run 函数），用于 backward-compat
 *   （用户写 `EXECUTORS.myCli = {run: async (p,o) => ...}` 这种老代码）。
 *
 * 注意：acceptsProvider 是关键约束——锁定型 CLI 配 provider 必须在 resolveAgent 抛错。
 */
export const EXECUTORS = buildBuiltinExecutors()

/** 取执行器描述符；未注册抛 ConfigError。 */
export function getExecutor(name) {
  const e = EXECUTORS[name]
  if (!e) {
    throw new ConfigError(`未知执行器 '${name}'（已知：${Object.keys(EXECUTORS).join(' / ')}）`)
  }
  return {
    name,
    executorName: e.executorName,
    acceptsProvider: !!e.acceptsProvider,
    applyProvider: e.applyProvider,  // 仅自定义 entry 可能提供；内置走 provider.js 的 BYO 翻译器
    run: e.run,
  }
}

/**
 * 注册自定义执行器，之后 runAgent({cli: name}) 和 resolveAgent 都能识别。
 *
 * 自定义执行器必须提供 run(prompt, opts) 函数，跟旧 adapter 接口一致：
 *   async (prompt, opts) => String & {text, _meta}
 *
 * @param {string}   name           执行器名（如 'my-cli'）
 * @param {Function} run            adapter 函数
 * @param {object}   [opts]
 * @param {Function} [opts.applyProvider]  provider 翻译器 (bundle) => {env?, model?}；
 *                                         提供则表示该执行器接受外部 provider（BYO-LLM）。
 * @param {boolean}  [opts.acceptsProvider]  同义于 applyProvider 存在；二者取一
 */
export function registerExecutor(name, run, { applyProvider, acceptsProvider } = {}) {
  assertSafeIdent(name, 'executor')
  if (typeof run !== 'function') throw new TypeError(`registerExecutor: run 必须是函数`)
  const entry = { run }
  if (applyProvider) {
    entry.applyProvider = applyProvider
    entry.acceptsProvider = true
  } else if (acceptsProvider) {
    entry.acceptsProvider = true
  }
  EXECUTORS[name] = entry
}

/** 加载并合并多层 agent profile 配置（~/.flowcast + <repo>/.flowcast，向后兼容 .flowx/）。 */
export async function loadAgents({ repo, dirs } = {}) {
  return loadMergedConfig(basenamesFor('agents'), { repo, dirs, key: 'agents' })
}

const META_KEYS = new Set(['executor', 'provider'])

// 顶层 opts 字段白名单：profile 里允许出现的「调用选项」key。
// 透传给 adapter 的所有字段必须在这里声明——白名单外的字段被静默丢弃（防 LLM 注入）。
const SAFE_OPTS_KEYS = new Set([
  'cwd', 'timeout', 'model', 'maxSteps', 'allowTools',
  'extraArgs',
  'transcriptOut', 'pricingFile',
  'files',
])

// extraArgs 元素级白名单：只允许 BYO-LLM adapter 已知安全的 flag。
// LLM/配置文件若注入 `--system-prompt-file /etc/shadow` 这种 flag，会被这里拦掉。
//
// 注：v0.6 之后，extraArgs 会通过 agentproc 的 env / args 机制传给 CLI。
// 白名单仍由 flowcast 维护——因为 agentproc 没有「per-CLI flag 白名单」概念。
const EXTRA_ARGS_WHITELIST = {
  claude: new Set([
    '--model', '--output-format', '--max-steps', '--allowedTools', '--system-prompt',
    '--dangerously-skip-permissions',
  ]),
  recursive: new Set([
    '--max-steps', '--model',
    '--workspace',
  ]),
  aider: new Set([
    '--model', '--edit-format', '--no-auto-commits', '--no-dirty-commits', '--read',
  ]),
  cursor: new Set(['--trust', '--force', '--yolo', '--dangerously-skip-permissions']),
  gemini: new Set(),
  codex:  new Set(),
  agy:    new Set(['--dangerously-skip-permissions']),
}

const PATH_FLAGS = new Set(['--workspace'])

function isSafePath(val) {
  if (typeof val !== 'string') return false
  if (val.startsWith('/')) return false
  const norm = normalize(val)
  return !norm.startsWith('..')
}

export function sanitizeExtraArgs(executor, args) {
  if (!Array.isArray(args)) return []
  const allowed = EXTRA_ARGS_WHITELIST[executor]
  if (!allowed) return []
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (typeof a !== 'string' || !a.startsWith('--')) continue
    const eq = a.indexOf('=')
    const flag = eq >= 0 ? a.slice(0, eq) : a
    if (!allowed.has(flag)) continue
    let value = eq >= 0 ? a.slice(eq + 1) : null
    let nextConsumed = false
    if (eq < 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      value = args[i + 1]
      nextConsumed = true
    }
    if (PATH_FLAGS.has(flag) && value !== null && !isSafePath(value)) continue
    out.push(a)
    if (nextConsumed) { out.push(value); i++ }
  }
  return out
}

/**
 * 解析具名 agent profile 为可直接喂给执行器的 { executor, run, opts }。
 *
 * v0.6：opts 不再透传给 per-CLI adapter（已删除），而是描述「agentproc profile + RunOptions」。
 * opts.env 来自 provider 翻译；opts.model 来自 provider 或 profile 显式；其余字段进入 ctx。
 *
 * @param {string} name
 * @param {Record<string,object>} agents
 * @param {object} [ctx]
 * @param {Record<string,object>} [ctx.providers]
 * @param {object} [ctx.env]
 * @returns {{executor:string, run:Function, opts:object}}
 */
export function resolveAgent(name, agents = {}, { providers = {}, env = process.env } = {}) {
  const profile = agents[name]
  if (!profile) {
    if (isDryRun()) return { executor: name, run: makeFakeRun(name), opts: {} }
    const known = Object.keys(agents)
    const hint = known.length ? `已定义：${known.join(' / ')}` : '当前无任何 agent 配置，请创建 ~/.flowcast/agents.json'
    throw new ConfigError(`未知 agent '${name}'（${hint}）`)
  }
  if (!profile.executor) throw new ConfigError(`agent '${name}' 缺少 executor 字段`)

  const ex = getExecutor(profile.executor)

  // 透传业务调用选项（白名单外的字段静默丢弃）
  const opts = {}
  for (const [k, v] of Object.entries(profile)) {
    if (META_KEYS.has(k)) continue
    if (!SAFE_OPTS_KEYS.has(k)) continue
    opts[k] = v
  }
  // extraArgs 元素级白名单过滤
  if (opts.extraArgs) {
    opts.extraArgs = sanitizeExtraArgs(profile.executor, opts.extraArgs)
  }
  // 路径型白名单字段
  for (const pathKey of ['transcriptOut', 'pricingFile']) {
    if (opts[pathKey] != null && !isSafePath(String(opts[pathKey]))) {
      throw new PathError(
        `agent '${name}': ${pathKey} 必须是相对路径且不能逃逸工作目录（不允许绝对路径或 ..），收到：${opts[pathKey]}`,
      )
    }
  }
  if (Array.isArray(opts.files)) {
    for (const f of opts.files) {
      if (typeof f === 'string' && !isSafePath(f)) {
        throw new PathError(`agent '${name}': files 数组包含不安全路径（绝对路径或 ..）：${f}`)
      }
    }
  }

  // provider 翻译 → opts.env（与旧 EXECUTORS.acceptsProvider 行为一致）
  if (profile.provider) {
    if (!ex.acceptsProvider) {
      throw new ConfigError(
        `执行器 '${profile.executor}' 不接受外部 provider（自管鉴权/路由）；请从 agent '${name}' 去掉 provider，改用它自带的 model 选择`,
      )
    }
    if (!isDryRun()) {
      const bundle = resolveProvider(profile.provider, providers, env)
      // bundle 暂存到 opts.__providerBundle，runAgent 时由 applyProviderToProfile 写入 agentproc profile.env
      opts.__providerBundle = bundle
      // 自定义执行器的 applyProvider 翻译器优先（用户自定义的 provider→{env,model} 转换）
      if (ex.applyProvider) {
        const applied = ex.applyProvider(bundle) ?? {}
        if (applied.env) opts.env = { ...(opts.env ?? {}), ...applied.env }
        if (applied.model != null && opts.model == null) opts.model = applied.model
      } else {
        // 内置 BYO-LLM CLI：走 provider.js 的内置翻译器
        const envTranslator = getEnvTranslator(profile.executor)
        if (envTranslator) {
          const env = envTranslator(bundle)
          if (env) opts.env = { ...(opts.env ?? {}), ...env }
        }
        if (bundle.model != null && opts.model == null) opts.model = bundle.model
      }
    }
  }

  const run = isDryRun() ? makeFakeRun(profile.executor) : (ex.run ?? makeDefaultRun())
  return { executor: profile.executor, run, opts }
}

/** 取 provider→env 翻译器（用于 resolveAgent 的旧行为兼容路径）。 */
function getEnvTranslator(cli) {
  switch (cli) {
    case 'claude':    return claudeProviderEnv
    case 'recursive': return recursiveProviderEnv
    case 'aider':     return aiderProviderEnv
    default:          return null
  }
}

/** dry-run 假执行器：不调真 CLI，返回成功占位 + _meta。 */
function makeFakeRun(executor) {
  return async (goal, _opts = {}) => {
    return makeAgentResult(
      `[dry-run] ${executor} would run: ${String(goal ?? '').slice(0, 80)}`,
      { cli: executor, dryRun: true, exitCode: 0 },
    )
  }
}

/**
 * 默认 run：把 opts 转给 agentproc SDK。
 *
 * 处理流程：
 *   1. 把 opts 转成 agentproc profile（executor / env / cwd / timeout 等）
 *   2. 如果 opts.__providerBundle 存在，applyProviderToProfile 合并 provider env
 *   3. 调 runViaAgentProc → agentproc.run → 返回 makeAgentResult
 *   4. 若 cli === 'recursive' 且 throwOnCritical=true，走 recursive-extras 的额外校验
 */
function makeDefaultRun() {
  return async (prompt, opts = {}) => {
    const cli = opts.__cli || 'claude'
    const ctx = {
      cli,
      cwd: opts.cwd ?? _defaultCwd,
      timeout: opts.timeout,
      env: opts.env,
      envAllowlist: opts.envAllowlist,
      streaming: opts.streaming,
    }
    const apOpts = {
      sessionId: opts.sessionId,
      onPartial: opts.onPartial,
      onError: opts.onError,
      onSession: opts.onSession,
      onStderr: opts.onStderr,
      extraEnv: opts.extraEnv,
    }
    if (opts.__providerBundle) {
      const profile = applyProviderToProfile({ env: ctx.env || {} }, cli, opts.__providerBundle)
      ctx.env = profile.env
    }

    // 优先走 agentproc SDK 路径
    let result = await runViaAgentProc(prompt, ctx, apOpts)
    if (result && result.__flowcastPath) {
      // agentproc SDK 不收录此 CLI（如 recursive）——走 flowcast 自己的路径
      return await runRecursiveDirect(result.prompt, result.ctx, opts)
    }
    // recursive 走 agentproc 路径时的 post-process（保留 fallback 兼容）
    if (cli === 'recursive' && result && result._meta) {
      const fakeResult = {
        reply: String(result),
        exitCode: result._meta.exitCode ?? 0,
        timedOut: result._meta.timedOut ?? false,
      }
      const extra = maybeThrowRecursiveCritical(fakeResult, { ...opts, throwOnCritical: opts.throwOnCritical })
      for (const [k, v] of Object.entries(extra)) {
        result._meta[k] = v
      }
    }
    return result
  }
}

/**
 * flowcast 自己的 recursive 执行路径（agentproc SDK 不收录 recursive）。
 * 直接 spawn recursive 二进制 → 解析 [done after N steps] reason → 应用 throwOnCritical。
 */
async function runRecursiveDirect(prompt, ctx, opts) {
  const { resolveRecursiveBin, deriveRecursiveMeta, maybeThrowRecursiveCritical } = await import('./executor/recursive-extras.js')
  const { spawnCapture } = await import('./spawn.js')
  const { makeAgentResult } = await import('./helpers.js')

  const bin = opts.bin ?? resolveRecursiveBin(ctx.cwd)
  const workspace = opts.workspace ?? '.'
  const args = ['--workspace', workspace]
  if (opts.systemPromptFile) args.push('--system-prompt-file', opts.systemPromptFile)
  if (opts.transcriptOut) args.push('--transcript-out', opts.transcriptOut)
  if (opts.pricingFile) args.push('--pricing-file', opts.pricingFile)
  if (opts.model) args.push('--model', opts.model)
  if (opts.maxSteps) args.push('--max-steps', String(opts.maxSteps))
  if (opts.allowTools) args.push('--allow-tools', opts.allowTools)
  if (ctx.env) Object.assign(args)  // no-op；env 走 spawnCapture 的 env 参数
  args.push('run', String(prompt ?? ''))

  const env = ctx.env ? { ...process.env, ...ctx.env } : undefined
  const r = await spawnCapture(bin, args, {
    cwd: ctx.cwd,
    timeout: ctx.timeout,
    env,
    onData: opts.onData,
  })
  if (r.spawnError) {
    throw new SpawnError(`[recursive] spawn error: ${r.spawnError}`, r.spawnError, {
      _meta: { cli: 'recursive', exitCode: -1, spawnError: r.spawnError },
    })
  }
  if (r.timedOut) {
    throw new TimeoutError(`[recursive] timeout after ${ctx.timeout}ms`, {
      _meta: { cli: 'recursive', exitCode: r.exitCode ?? -1, timedOut: true },
    })
  }

  // 应用 throwOnCritical（panicked / budgetExceeded / 非零退出 → FlowcastError）
  maybeThrowRecursiveCritical(r, opts)

  const meta = deriveRecursiveMeta(r, opts)
  meta.cli = 'recursive'
  meta.exitCode = r.exitCode
  meta.timedOut = false
  return makeAgentResult(r.stdout, meta)
}

// ── runAgent 路由 ───────────────────────────────────────────────────────

let _defaultCwd = process.cwd()

/**
 * @deprecated 进程级单例，并发不安全。推荐每次 runAgent 显式传 cwd。
 */
export function setWorkdir(dir) {
  _defaultCwd = dir
}

const RUN_AGENT_ALL_KEYS = new Set([
  ...SAFE_OPTS_KEYS,
  'provider', 'env', 'bin', 'log', 'onData', 'replayFrom', 'workspace',
  'apiKey', 'apiBase',
  'throwOnCritical',
  'sessionId',  // 跨 turn 续接（agentproc 支持）
  'streaming',
  'onPartial', 'onError', 'onSession', 'onStderr',
  'envAllowlist',
  'extraEnv',
])

/**
 * 跑一次 agent。
 *
 * @param {string} prompt
 * @param {object} [o]
 * @param {string} [o.cli='claude']
 * @param {string} [o.cwd]
 * @param {object} [o.schema]
 * @param {number} [o.schemaRetries=1]
 */
export async function runAgent(prompt, { cli = 'claude', cwd, schema, schemaRetries = 1, ...opts } = {}) {
  // opts 白名单过滤（防 LLM 生成代码注入）
  const safeOpts = {}
  for (const [k, v] of Object.entries(opts)) {
    if (RUN_AGENT_ALL_KEYS.has(k)) safeOpts[k] = v
  }
  // recursive 默认 throwOnCritical=true
  if (cli === 'recursive' && safeOpts.throwOnCritical === undefined) {
    safeOpts.throwOnCritical = true
  }
  // extraArgs 元素级白名单
  if (safeOpts.extraArgs) {
    safeOpts.extraArgs = sanitizeExtraArgs(cli, safeOpts.extraArgs)
  }
  // 路径型参数安全检查
  for (const pathKey of ['systemPromptFile', 'transcriptOut', 'pricingFile']) {
    if (opts[pathKey] != null) {
      if (!isSafePath(String(opts[pathKey]))) {
        throw new PathError(
          `runAgent: ${pathKey} 必须是相对路径且不能逃逸工作目录（不允许绝对路径或 ..），收到：${opts[pathKey]}`,
        )
      }
      safeOpts[pathKey] = opts[pathKey]
    }
  }

  if (isDryRun()) {
    if (schema) return stubFromSchema(schema)
    return makeAgentResult(`[dry-run] ${cli} 未真实执行`, { cli, dryRun: true })
  }

  // 校验 CLI 是否在 EXECUTORS 里（内置或 registerExecutor）
  if (!EXECUTORS[cli]) {
    const known = Object.keys(EXECUTORS).join('/')
    throw new ConfigError(`未知 CLI: ${cli}，支持：${known}（或通过 registerExecutor 注册的自定义执行器）`)
  }

  // 构造 runner：优先用 EXECUTORS[cli].run（自定义 entry），否则用默认（agentproc）
  const entry = EXECUTORS[cli]
  const defaultRunner = makeDefaultRun()
  const fn = entry.run ?? defaultRunner

  // 把 cli 注入 opts.__cli（makeDefaultRun 需要），以及 cwd / safeOpts 合并
  const runner = (p) => fn(p, { __cli: cli, cwd: cwd ?? _defaultCwd, ...safeOpts })

  if (schema) return runStructured(runner, prompt, { schema, retries: schemaRetries })
  return runner(prompt)
}

// ── runAgentChain：跨 CLI 链式回退 ──────────────────────────────────────

function specLabel(spec = {}) {
  return `${spec.cli ?? 'claude'}${spec.provider?.name ? '/' + spec.provider.name : ''}`
}

export const AGENT_COOLDOWN_BASE_MS = 30_000
export const AGENT_COOLDOWN_MAX_MS = 480_000

function envMs(newName, oldName, fallback) {
  if (process.env[newName] != null) {
    const v = parseInt(process.env[newName], 10)
    return Number.isFinite(v) && v >= 0 ? v : fallback
  }
  if (process.env[oldName] != null) {
    console.warn(`[flowcast] ${oldName} 已弃用，请改用 ${newName}`)
    const v = parseInt(process.env[oldName], 10)
    return Number.isFinite(v) && v >= 0 ? v : fallback
  }
  return fallback
}
function defaultCooldownBaseMs() { return envMs('FLOWCAST_AGENT_COOLDOWN_BASE_MS', 'FLOWX_AGENT_COOLDOWN_BASE_MS', AGENT_COOLDOWN_BASE_MS) }
function defaultCooldownMaxMs() { return envMs('FLOWCAST_AGENT_COOLDOWN_MAX_MS', 'FLOWX_AGENT_COOLDOWN_MAX_MS', AGENT_COOLDOWN_MAX_MS) }

function backoffMs(fails, base = AGENT_COOLDOWN_BASE_MS, cap = AGENT_COOLDOWN_MAX_MS) {
  const ms = Math.min(base * 2 ** Math.max(0, fails - 1), cap)
  return Math.round(ms * (0.9 + Math.random() * 0.2))
}

function coolRemaining(cooldown, spec, now) {
  let persistedMs = 0
  if (spec.model) {
    const persisted = getAvailableAt(spec.cli ?? 'claude', spec.model)
    persistedMs = persisted ? persisted.remainingMs : 0
  }
  if (!cooldown) return persistedMs
  const entry = cooldown.get(specLabel(spec))
  const until = entry && typeof entry === 'object' ? entry.until : entry
  const memMs = until && until > now ? until - now : 0
  return Math.max(persistedMs, memMs)
}

/**
 * 跨 CLI 的 agent 链式回退。
 */
export async function runAgentChain(prompt, chain, {
  runner = runAgent, cooldown = null,
  cooldownBaseMs = defaultCooldownBaseMs(), cooldownMaxMs = defaultCooldownMaxMs(),
} = {}) {
  const list = Array.isArray(chain) && chain.length ? chain : [{}]
  const now = Date.now()
  const order = (() => {
    const withCool = list.map((spec, i) => ({ spec, i, cool: coolRemaining(cooldown, spec, now) }))
    const hasAnyBlock = withCool.some(x => x.cool > 0)
    return hasAnyBlock
      ? withCool.sort((a, b) => (a.cool - b.cool) || (a.i - b.i)).map(x => x.spec)
      : [...list]
  })()
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
        if (isProviderRetryable(e) && !e.timedOut) {
          const rawOutput = e.output ?? e.message ?? ''
          const useLLM = Boolean(process.env.FLOWCAST_RATE_LIMIT_LLM)
          recordRateLimit(spec.cli ?? 'claude', spec.model, rawOutput, { useLLM }).then(({ source, availableAt }) => {
            const eta = new Date(availableAt).toLocaleString()
            console.warn(`  [rate-limit] ${makeKey(spec.cli ?? 'claude', spec.model)} 限流，下次可用：${eta}（来源：${source}）`)
            emitAgentEvent(makeEvent(EVENT.RATE_LIMIT, { cli: spec.cli, model: spec.model, availableAt, source }))
          }).catch(() => { /* 记录失败不影响主流程 */ })
        }
        if (cooldown) {
          const prev = cooldown.get(from)
          const fails = (prev && typeof prev === 'object' ? prev.fails ?? 0 : 0) + 1
          cooldown.set(from, { until: Date.now() + backoffMs(fails, cooldownBaseMs, cooldownMaxMs), fails })
        }
        if (i < order.length - 1) {
          const to = specLabel(order[i + 1])
          console.warn(`  [agent fallback] ${from} 不可用（${reason}），切换 → ${to}`)
          emitAgentEvent(makeEvent(EVENT.FALLBACK, { scope: 'cli', from, to, reason }))
          continue
        }
      }
      throw e
    }
  }
  throw lastErr ?? new FlowcastError('runAgentChain: 所有 provider 均失败')
}

// ── agentEventSink（emitAgentEvent）：从 adapters.js 迁来 ──────────────

let _agentEventSink = null

export function setAgentEventSink(fn) {
  _agentEventSink = typeof fn === 'function' ? fn : null
}

/**
 * emit agent 观测事件（fallback / rate-limit 等）。
 * 接收 events.js schema 包装好的事件对象（带 event / ts / ... 字段）。
 */
export function emitAgentEvent(e) {
  if (!_agentEventSink) return
  const normalized = (e && e.event) ? e : makeEvent(e?.type ?? 'agent', e ?? {})
  try { _agentEventSink(normalized) } catch { /* 观测失败不影响主流程 */ }
}