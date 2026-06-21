// executor.js — 执行器能力分层 + agent profile 绑定层
//
// 「执行器（怎么驱动一个 CLI/agent）」与「provider（用哪个 LLM）」是正交的两件事：
//   - 有些执行器是 BYO-LLM（recursive/aider/claude）：可以注入 provider（端点/模型/密钥）。
//   - 有些执行器自管鉴权、路由到自家后端（cursor/gemini/codex 等）：不接受外部 provider，
//     只能用它自带的 model 选择。
//
// 一个执行器是否「接受外部 provider」由 adapter 自己有没有 applyProvider 翻译器决定（能力即翻译器）。
// applyProvider(bundle) 把通用 provider bundle 翻译成该执行器的调用选项 { env?, model? }。
// 本文件只做「按名字拿 adapter + 派生 acceptsProvider」的薄编排——翻译器在 adapter 里维护。
//
// agent profile（agents.{json,yaml,…}）把「执行器 + 可选 provider + 调用配置」打包成具名引用，
// flow / L3 编排层按名字引用它。resolveAgent 负责校验 + 解析 + 绑定。

// 从 adapters.js 直接导入（不再经由 agent.js），打破 executor.js ↔ agent.js ESM 循环依赖。
import {
  claude, cursor, gemini, codex, aider, recursive, agy,
  recursiveProviderEnv, claudeApplyProvider, emitAgentEvent,
} from './adapters.js'
import { isProviderRetryable } from './spawn.js'
import { resolveProvider, loadMergedConfig, basenamesFor } from './provider.js'
import { isDryRun } from './dry-run.js'
import { runStructured, stubFromSchema } from './schema.js'
import { ConfigError, PathError } from './errors.js'
import { assertSafeIdent } from './helpers.js'
import { resolve, normalize } from 'path'

// ── provider 翻译器（adapter 各自管自己的，本文件只做装配）──────────
//
// 设计选择：翻译器不挂到 adapter 函数上（避免 ESM 模块初始化时序坑），
// 改成 export 翻译器函数，本文件装配 EXECUTORS 时挂上去。
// 单一事实来源仍是 adapter 自带的 provider 逻辑，只是「挂载点」在本文件。

function recursiveApply(bundle) {
  return { env: recursiveProviderEnv(bundle) }
}

function aiderApply(bundle) {
  const env = {}
  if (bundle.apiBase) env.OPENAI_API_BASE = bundle.apiBase
  if (bundle.apiKey) env.OPENAI_API_KEY = bundle.apiKey
  return { env, model: bundle.model }
}

// ── 执行器注册表 ──────────────────────────────────────────────────
// acceptsProvider 由 applyProvider 是否存在派生（单一事实来源）。

export const EXECUTORS = {
  recursive: { run: recursive, applyProvider: recursiveApply },
  aider:     { run: aider,     applyProvider: aiderApply },
  claude:    { run: claude,    applyProvider: claudeApplyProvider },
  cursor:    { run: cursor },   // 自管鉴权/路由，不接受外部 provider
  agent:     { run: cursor },   // cursor-agent CLI（二进制名 agent）的别名
  gemini:    { run: gemini },
  codex:     { run: codex },
  agy:       { run: agy },      // 自带鉴权的编译型 agent CLI
}

/** 取执行器描述符；未注册抛 ConfigError。 */
export function getExecutor(name) {
  const e = EXECUTORS[name]
  if (!e) throw new ConfigError(`未知执行器 '${name}'（已注册：${Object.keys(EXECUTORS).join(' / ')}）`)
  return { name, run: e.run, applyProvider: e.applyProvider, acceptsProvider: typeof e.applyProvider === 'function' }
}

/**
 * 注册自定义执行器，之后 runAgent({cli: name}) 和 resolveAgent 都能识别。
 * @param {string}   name           执行器名（如 'my-cli'）
 * @param {Function} run            adapter 函数 async (prompt, opts) => string
 * @param {object}   [opts]
 * @param {Function} [opts.applyProvider]  provider 翻译器 (bundle) => {env?, model?}；
 *                                         提供则表示该执行器接受外部 provider（BYO-LLM）。
 */
export function registerExecutor(name, run, { applyProvider } = {}) {
  assertSafeIdent(name, 'executor')
  if (typeof run !== 'function') throw new TypeError(`registerExecutor: run 必须是函数`)
  EXECUTORS[name] = applyProvider ? { run, applyProvider } : { run }
}

/** 加载并合并多层 agent profile 配置（~/.flowcast + <repo>/.flowcast，向后兼容 .flowx/）。 */
export async function loadAgents({ repo, dirs } = {}) {
  return loadMergedConfig(basenamesFor('agents'), { repo, dirs, key: 'agents' })
}

const META_KEYS = new Set(['executor', 'provider'])

// 顶层 opts 字段白名单：profile 里允许出现的「调用选项」key。
// 透传给 adapter 的所有字段必须在这里声明——白名单外的字段被静默丢弃（防 LLM 注入
// `systemPromptFile: '/etc/shadow'`、`workspace: '/etc'` 等任意文件路径）。
// 注：这是 L2 配置文件（agents.json）的白名单；generated flow 调的
// `runProfile(agentName, goal, opts)` 走的是另一条 surface（runAgent chain），
// 不受本表约束——runProfile 的 opts 校验在 agent.js 入口处。
const SAFE_OPTS_KEYS = new Set([
  'cwd', 'timeout', 'model', 'maxSteps', 'allowTools',
  'extraArgs',  // 数组里每个 arg 仍要走 EXTRA_ARGS_WHITELIST 二次过滤
  'transcriptOut', 'pricingFile',  // recursive 专用，路径约束在 adapter 内部
  'files',  // aider 专用：要操作的文件列表（string[]）；路径安全由 aider CLI 自身保证
])

// extraArgs 元素级白名单：只允许 BYO-LLM adapter 已知安全的 flag。
// LLM/配置文件若注入 `--system-prompt-file /etc/shadow` 这种 flag，会被这里拦掉。
const EXTRA_ARGS_WHITELIST = {
  claude: new Set([
    '--model', '--output-format', '--max-steps', '--allowedTools', '--system-prompt',
    '--dangerously-skip-permissions',
  ]),
  recursive: new Set([
    '--max-steps', '--model',
    '--workspace',  // 路径值由 sanitizeExtraArgs 校验：必须相对且不逃逸（见 PATH_FLAGS）
  ]),
  // aider 是 BYO-LLM 执行器，接受模型/编辑格式等配置 flag
  aider: new Set([
    '--model', '--edit-format', '--no-auto-commits', '--no-dirty-commits', '--read',
  ]),
  // 锁定型执行器只允许运行时安全 flag（workspace 信任/宽松权限），不允许注入 LLM 配置 flag
  cursor: new Set(['--trust', '--force', '--yolo', '--dangerously-skip-permissions']),
  gemini: new Set(),
  codex:  new Set(),
  agy:    new Set(['--dangerously-skip-permissions']),
}

// path 型 flag：其值必须是相对路径且不能逃逸当前工作目录（防路径遍历）。
const PATH_FLAGS = new Set(['--workspace'])

/**
 * 判断路径值是否安全：必须是相对路径（不以 / 开头），且规范化后不以 `..` 开头。
 * @param {string} val
 */
function isSafePath(val) {
  if (typeof val !== 'string') return false
  if (val.startsWith('/')) return false  // 绝对路径拒绝
  const norm = normalize(val)
  return !norm.startsWith('..')  // 规范化后的相对路径不能逃逸
}

/**
 * 过滤 extraArgs 数组：只保留白名单内 flag 的元素，且校验 flag 后的 value 不带危险字符。
 * 对 path 型 flag（如 --workspace），额外校验路径不含路径遍历（不允许绝对路径或 `..`）。
 * @param {string} executor  执行器名
 * @param {string[]} args
 * @returns {string[]} 过滤后的数组（白名单外的、路径遍历的均被丢弃）
 */
export function sanitizeExtraArgs(executor, args) {
  if (!Array.isArray(args)) return []
  const allowed = EXTRA_ARGS_WHITELIST[executor]
  if (!allowed) return []  // 未知执行器：拒绝任何 extraArgs（保守）
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (typeof a !== 'string' || !a.startsWith('--')) continue  // 跳过非 flag 形如（值会跟在前一个 flag 一起处理）
    // 解析 flag 名：支持 --flag value / --flag=value 两种
    const eq = a.indexOf('=')
    const flag = eq >= 0 ? a.slice(0, eq) : a
    if (!allowed.has(flag)) continue  // 丢弃非白名单 flag

    // 提取 value（两种形式：--flag=val 或 --flag val）
    let value = eq >= 0 ? a.slice(eq + 1) : null
    let nextConsumed = false
    if (eq < 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      value = args[i + 1]
      nextConsumed = true
    }

    // path 型 flag：校验值不逃逸工作目录
    if (PATH_FLAGS.has(flag) && value !== null && !isSafePath(value)) continue

    out.push(a)
    if (nextConsumed) { out.push(value); i++ }
  }
  return out
}

/**
 * 解析具名 agent profile 为可直接喂给执行器的 { executor, run, opts }。
 * @param {string} name      agent profile 名
 * @param {Record<string,object>} agents     已加载的 agents map
 * @param {object} [ctx]
 * @param {Record<string,object>} [ctx.providers]  已加载的 providers map（provider 解析用）
 * @param {object} [ctx.env]                       插值用 env（默认 process.env）
 * @returns {{executor:string, run:Function, opts:object}}
 */
export function resolveAgent(name, agents = {}, { providers = {}, env = process.env } = {}) {
  const profile = agents[name]
  if (!profile) {
    // dry-run 是结构冒烟，不校验 agent 配置是否齐全 → 给个 fake runner 让 flow 跑下去
    if (isDryRun()) return { executor: name, run: makeFakeRun(name), opts: {} }
    const known = Object.keys(agents)
    const hint = known.length ? `已定义：${known.join(' / ')}` : '当前无任何 agent 配置，请创建 ~/.flowcast/agents.json'
    throw new ConfigError(`未知 agent '${name}'（${hint}）`)
  }
  if (!profile.executor) throw new ConfigError(`agent '${name}' 缺少 executor 字段`)

  const ex = getExecutor(profile.executor)

  // 透传业务无关的调用选项（maxSteps / cwd / timeout / allowTools / model / workspace …）
  // 白名单外字段静默丢弃——防 LLM 注入 systemPromptFile/workspace 等任意路径字段。
  const opts = {}
  for (const [k, v] of Object.entries(profile)) {
    if (META_KEYS.has(k)) continue
    if (!SAFE_OPTS_KEYS.has(k)) continue  // 丢弃非白名单字段
    opts[k] = v
  }
  // extraArgs 内部元素级白名单过滤（防 `--system-prompt-file /etc/shadow` 注入）
  if (opts.extraArgs) {
    opts.extraArgs = sanitizeExtraArgs(profile.executor, opts.extraArgs)
  }

  // 路径型白名单字段：transcriptOut / pricingFile / files 里的路径元素。
  // 这些字段允许通过 agents.json 配置——若配置文件被篡改或注入，未校验的路径
  // 可能导致 CLI 写入/读取任意系统文件（路径穿越）。
  // 复用 isSafePath 守卫：必须是相对路径、规范化后不以 `..` 开头。
  for (const pathKey of ['transcriptOut', 'pricingFile']) {
    if (opts[pathKey] != null && !isSafePath(String(opts[pathKey]))) {
      throw new PathError(
        `agent '${name}': ${pathKey} 必须是相对路径且不能逃逸工作目录` +
        `（不允许绝对路径或 ..），收到：${opts[pathKey]}`,
      )
    }
  }
  // files 数组（aider 专用）：每个元素单独校验
  if (Array.isArray(opts.files)) {
    for (const f of opts.files) {
      if (typeof f === 'string' && !isSafePath(f)) {
        throw new PathError(
          `agent '${name}': files 数组包含不安全路径（绝对路径或 ..）：${f}`,
        )
      }
    }
  }

  if (profile.provider) {
    if (!ex.acceptsProvider) {
      throw new ConfigError(
        `执行器 '${profile.executor}' 不接受外部 provider（自管鉴权/路由）；` +
        `请从 agent '${name}' 去掉 provider，改用它自带的 model 选择`,
      )
    }
    // dry-run 跳过真实 provider 解析（无需真 key），但 provider-locked 校验上面已恒做
    if (!isDryRun()) {
      const bundle = resolveProvider(profile.provider, providers, env)
      const applied = ex.applyProvider(bundle) ?? {}
      // profile 显式选项优先于翻译器产出（如 profile 里写了 model，不被 provider 默认 model 覆盖）
      opts.env = { ...(applied.env ?? {}), ...(opts.env ?? {}) }
      if (applied.model != null && opts.model == null) opts.model = applied.model
    }
  }

  const run = isDryRun() ? makeFakeRun(profile.executor) : ex.run
  return { executor: profile.executor, run, opts }
}

/** dry-run 假执行器：不调真 CLI，返回成功占位 + _meta。 */
function makeFakeRun(executor) {
  return async (goal, _opts = {}) => {
    const out = `[dry-run] ${executor} would run: ${String(goal ?? '').slice(0, 80)}`
    return Object.assign(out, { _meta: { cli: executor, dryRun: true, exitCode: 0 } })
  }
}

// ── runAgent 路由 ────────────────────────────────────────────────────
//
// 从 agent.js 迁来，消除 agent.js ↔ executor.js 初始化时序循环依赖：
//   - 旧位置（agent.js）：无法静态引用 EXECUTORS，只能 dynamic import executor.js（技术债）。
//   - 新位置（本文件）：EXECUTORS 在同一文件，直接访问；agent.js 静态 re-export 保持 API 不变。
// ESM 安全性：agent.js 的 adapter 函数均为 function 声明（已提升），executor.js 初始化时
// agent.js 已完成提升，EXECUTORS 可安全取到 claude/cursor 等正确引用。

let _defaultCwd = process.cwd()

/**
 * 设置全局默认工作目录，flow 启动时调用一次，之后所有 runAgent 自动继承。
 *
 * ⚠️ 并发安全提示：`_defaultCwd` 是进程级单例。
 *   - fanOut / orchestrateMulti 的并发子任务跑在独立 node 子进程里，各自有自己的 `_defaultCwd`，安全。
 *   - 同一进程内若并发调用多次 `setWorkdir` + `runAgent`，则 `_defaultCwd` 会被竞争覆盖。
 *     避免方法：每次 `runAgent` 调用时显式传 `cwd` 参数，不依赖全局默认值。
 *
 * @param {string} dir  全局默认工作目录（绝对路径）
 */
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
 *   - 其余透传给底层执行器 adapter（经 SAFE_RUN_OPTS_KEYS 白名单 + 路径安全校验）
 */
// runAgent 可接受的 opts key 白名单（代码级 API，比 resolveAgent 的 SAFE_OPTS_KEYS 更宽松）：
// ┌─────────────────────┬────────────────────────────────────────────────────────────────────┐
// │ 来源                │ 说明                                                               │
// ├─────────────────────┼────────────────────────────────────────────────────────────────────┤
// │ SAFE_OPTS_KEYS      │ 与 agents.json 配置文件白名单对齐（config + flow 两处都允许）      │
// │ 以下额外 key         │ 仅 runAgent 代码级调用允许（generated flow 是受信代码，但不是     │
// │                     │ 外部配置文件——对配置文件保持更严的白名单）                         │
// └─────────────────────┴────────────────────────────────────────────────────────────────────┘
// 两套白名单合并成一次扫描，避免对 opts 双重迭代（旧实现冗余且 timeout/allowTools 各出现两次）。
const RUN_AGENT_ALL_KEYS = new Set([
  ...SAFE_OPTS_KEYS,
  // 以下仅代码级 runAgent 允许，不对外开放给 agents.json 配置文件：
  'provider', 'env', 'bin', 'log', 'onData', 'replayFrom', 'workspace',
  'apiKey', 'apiBase',
  'throwOnCritical',  // recursive 专用：true 时 panicked/budgetExceeded/非零退出抛 FlowcastError
])

export async function runAgent(prompt, { cli = 'claude', cwd, schema, schemaRetries = 1, ...opts } = {}) {
  // opts 白名单过滤（防 LLM 生成代码注入 systemPromptFile 等危险参数）。
  // runAgent 由 generated flow 直接调用，flow 本身是 LLM 生成的——同样需要防注入。
  const safeOpts = {}
  for (const [k, v] of Object.entries(opts)) {
    if (RUN_AGENT_ALL_KEYS.has(k)) safeOpts[k] = v
  }
  // P1 修复：recursive 非零退出默认抛错，防止失败被当成功静默返回。
  // 调用方可显式传 throwOnCritical: false 恢复旧行为（需要在 opts 白名单里）。
  if (cli === 'recursive' && safeOpts.throwOnCritical === undefined) {
    safeOpts.throwOnCritical = true
  }
  // extraArgs 元素级白名单（与 resolveAgent 一致）
  if (safeOpts.extraArgs) {
    safeOpts.extraArgs = sanitizeExtraArgs(cli, safeOpts.extraArgs)
  }
  // 路径型参数安全检查：防止 systemPromptFile/transcriptOut/pricingFile 路径穿越
  for (const pathKey of ['systemPromptFile', 'transcriptOut', 'pricingFile']) {
    if (opts[pathKey] != null) {
      if (!isSafePath(String(opts[pathKey]))) {
        throw new PathError(
          `runAgent: ${pathKey} 必须是相对路径且不能逃逸工作目录` +
          `（不允许绝对路径或 ..），收到：${opts[pathKey]}`,
        )
      }
      safeOpts[pathKey] = opts[pathKey]
    }
  }

  if (isDryRun()) {
    if (schema) return stubFromSchema(schema)
    return Object.assign(`[dry-run] ${cli} 未真实执行`, { _meta: { cli, dryRun: true } })
  }
  const entry = EXECUTORS[cli]
  if (!entry) {
    const known = Object.keys(EXECUTORS).join('/')
    throw new ConfigError(`未知 CLI: ${cli}，支持：${known}（或通过 registerExecutor 注册的自定义执行器）`)
  }
  const fn = entry.run
  const runner = (p) => fn(p, { cwd: cwd ?? _defaultCwd, ...safeOpts })
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
  // 始终拷贝（不直接引用 list/chain），防止循环内的 cooldown.delete 等操作意外修改外部数组。
  const order = cooldown
    ? list.map((spec, i) => ({ spec, i, cool: coolRemaining(cooldown, spec, now) }))
        .sort((a, b) => (a.cool - b.cool) || (a.i - b.i)).map(x => x.spec)
    : [...list]
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
  // 防御性兜底：正常路径最后一项失败已在循环内 throw e 退出，此处不可达。
  // 若将来循环逻辑变更导致意外走到这里，确保不静默返回 undefined。
  throw lastErr ?? new Error('runAgentChain: chain exhausted without result or error')
}
