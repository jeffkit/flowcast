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

import {
  claude, cursor, gemini, codex, aider, recursive, agy,
  recursiveProviderEnv, claudeApplyProvider,
} from './agent.js'
import { resolveProvider, loadMergedConfig, basenamesFor } from './provider.js'
import { isDryRun } from './dry-run.js'

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

/** 取执行器描述符；未注册抛错。 */
export function getExecutor(name) {
  const e = EXECUTORS[name]
  if (!e) throw new Error(`未知执行器 '${name}'（已注册：${Object.keys(EXECUTORS).join(' / ')}）`)
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
  if (typeof run !== 'function') throw new TypeError(`registerExecutor: run 必须是函数`)
  EXECUTORS[name] = applyProvider ? { run, applyProvider } : { run }
}

/** 加载并合并多层 agent profile 配置（~/.flowx + <repo>/.flowx）。 */
export async function loadAgents({ repo, dirs } = {}) {
  return loadMergedConfig(basenamesFor('agents'), { repo, dirs, key: 'agents' })
}

const META_KEYS = new Set(['executor', 'provider'])

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
    const hint = known.length ? `已定义：${known.join(' / ')}` : '当前无任何 agent 配置，请创建 ~/.flowx/agents.json'
    throw new Error(`未知 agent '${name}'（${hint}）`)
  }
  if (!profile.executor) throw new Error(`agent '${name}' 缺少 executor 字段`)

  const ex = getExecutor(profile.executor)

  // 透传业务无关的调用选项（maxSteps / cwd / timeout / allowTools / model / workspace …）
  const opts = {}
  for (const [k, v] of Object.entries(profile)) {
    if (!META_KEYS.has(k)) opts[k] = v
  }

  if (profile.provider) {
    if (!ex.acceptsProvider) {
      throw new Error(
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
