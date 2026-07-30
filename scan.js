// scan.js — flowcast 环境扫描（init / doctor 共用）
//
// 检测本机「能不能立刻跑起来」的三层信号：
//   1. PATH 二进制：每个内置 CLI（claude/cursor/...）是否在 PATH 里可执行
//   2. 已登录凭证：逐 CLI 探测已知登录信号（凭证文件 / env），判断是否就绪
//   3. 配置合法性：现有 ~/.flowcast + <repo>/.flowcast 的 agents/providers 配置是否可解析、
//      ${ENV} 是否能展开
//
// 设计为纯函数 + 依赖注入：which/exists/env/homeDir 都可从外部注入，便于单测。
// 不做任何写操作（写配置交给 init），doctor 也只读。

import { existsSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { CLI_TO_EXECUTOR } from './executor/agentproc-adapter.js'
import { loadAgents, EXECUTORS } from './executor.js'
import { loadProviders, interpolateEnv, basenamesFor } from './provider.js'
import { flowcastDir } from './dirs.js'
import { ConfigError } from './errors.js'

// BYO-LLM 的 CLI：可（且需要）配 provider。来自 executor.js 的 BYO_LLM_CLIS（保持同步）。
// 锁定型 CLI（cursor/gemini/codex/agy/...）自管鉴权，不配 provider。
const BYO_LLM_CLIS = new Set(['claude', 'recursive', 'aider'])

// CLI 别名：同一二进制多个调用名，扫描时只保留主名，避免重复 profile。
// key=别名，value=主名（别名在 CLI_TO_EXECUTOR 里映射到同一 executor）。
const CLI_ALIASES = { agent: 'cursor' }

/**
 * 默认 PATH 检测：用 `command -v <cli>` 探测二进制是否在 PATH 中。
 * 返回绝对路径；不存在返回 null。
 * @param {string} cli
 * @param {object} [deps]
 */
export function defaultWhich(cli, { env = process.env } = {}) {
  // command -v 是 POSIX sh 内建，跨 bash/zsh/dash 都有；-c 让 shell 解析 PATH。
  const r = spawnSync('sh', ['-c', `command -v ${JSON.stringify(cli)}`], {
    env, encoding: 'utf8',
  })
  if (r.status !== 0) return null
  const p = (r.stdout || '').trim()
  return p || null
}

// ── 凭证检测：每个 CLI 的「是否已登录」信号 ──────────────────────────────
//
// 每个 detector 返回 { authed: bool, detail?: string }。只读探测，绝不泄露密钥本身。
// 缺省 deps：exists/stat/homedir/env，都可注入测试。

function fileExists(p, { exists = existsSync, stat = statSync } = {}) {
  if (!exists(p)) return false
  try { return stat(p).isFile() } catch { return false }
}

/**
 * 逐 CLI 的凭证检测器。返回 { authed, detail? }。
 * 已知信号的 CLI 给出明确判定；未知信号返回 { authed: null }（不确定，不算失败）。
 */
export function detectAuth(cli, deps = {}) {
  const { env = process.env, home = homedir(), exists = existsSync, stat = statSync } = deps
  const has = (p) => fileExists(p, { exists, stat })

  switch (cli) {
    case 'claude': {
      // Claude Code CLI 登录后写 ~/.claude/.credentials.json 或 ~/.claude/.credentials.json
      if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
        return { authed: true, detail: 'env ANTHROPIC_API_KEY/AUTH_TOKEN 已设置' }
      }
      const cred = join(home, '.claude', '.credentials.json')
      if (has(cred)) return { authed: true, detail: '~/.claude/.credentials.json 存在' }
      return { authed: false, detail: '未找到登录凭证（也无 ANTHROPIC_API_KEY）' }
    }
    case 'cursor':
    case 'agent': {
      // cursor-agent 登录后写 ~/.cursor/ 目录（含凭证）
      const dir = join(home, '.cursor')
      if (exists(dir)) return { authed: true, detail: '~/.cursor/ 存在' }
      return { authed: false, detail: '未找到 ~/.cursor/（cursor-agent 未登录）' }
    }
    case 'gemini': {
      if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
        return { authed: true, detail: 'env GEMINI/GOOGLE_API_KEY 已设置' }
      }
      const cred = join(home, '.gemini', 'oauth_creds.json')
      if (has(cred)) return { authed: true, detail: '~/.gemini/oauth_creds.json 存在' }
      return { authed: false, detail: '未找到 gemini 凭证（也无 GEMINI_API_KEY）' }
    }
    case 'codex': {
      if (env.OPENAI_API_KEY) return { authed: true, detail: 'env OPENAI_API_KEY 已设置' }
      const cred = join(home, '.codex', 'auth.json')
      if (has(cred)) return { authed: true, detail: '~/.codex/auth.json 存在' }
      return { authed: false, detail: '未找到 codex 凭证（也无 OPENAI_API_KEY）' }
    }
    case 'aider': {
      // aider 走 OpenAI/Anthropic 协议，需 provider；凭证由 provider 的 ${ENV} 表达，这里看常见 env
      if (env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY) {
        return { authed: true, detail: 'env OPENAI/ANTHROPIC_API_KEY 已设置' }
      }
      return { authed: null, detail: 'aider 鉴权由 provider 决定（见 providers.json）' }
    }
    case 'recursive': {
      // recursive 自管 provider（RECURSIVE_*）；走 flowcast 自己的路径
      if (env.RECURSIVE_API_KEY) return { authed: true, detail: 'env RECURSIVE_API_KEY 已设置' }
      return { authed: null, detail: 'recursive 鉴权由 provider 决定（见 providers.json）' }
    }
    default:
      // 其余 CLI（agy/pi/opencode/...）无通用探测信号
      return { authed: null, detail: '无通用凭证探测信号（CLI 自管鉴权）' }
  }
}

/**
 * 扫描所有内置 CLI 的 PATH + 凭证状态。
 * @param {object} [deps]
 * @param {Function} [deps.which]     PATH 检测函数 (cli) => path|null
 * @param {object}    [deps.env]
 * @param {string}    [deps.home]     homedir
 * @returns {Promise<Array<{cli, executor, acceptsProvider, installed, path, authed, authDetail, ready}>>}
 *   ready = installed && (authed === true || authed === null)  // 不确定凭证的 CLI 只要装了即视为可用
 */
export async function scanAgents(deps = {}) {
  const {
    which = defaultWhich,
    env = process.env,
    home = homedir(),
    exists = existsSync,
    stat = statSync,
  } = deps

  const results = []
  for (const [cli, executor] of Object.entries(CLI_TO_EXECUTOR)) {
    // 跳过别名：只保留主名（如 agent → cursor），避免重复 profile
    if (CLI_ALIASES[cli]) continue
    const path = which(cli, { env })
    const installed = !!path
    const auth = detectAuth(cli, { env, home, exists, stat })
    // ready：装了 且 凭证非「明确未登录」。不确定(null)凭证的 CLI 装了即可用。
    const ready = installed && auth.authed !== false
    results.push({
      cli,
      executor,
      acceptsProvider: BYO_LLM_CLIS.has(cli),
      installed,
      path,
      authed: auth.authed,
      authDetail: auth.detail,
      ready,
    })
  }
  return results
}

// ── 配置合法性扫描 ────────────────────────────────────────────────────────

/**
 * 校验一份已加载的 agents map：每个 profile 的 executor 是否已知、引用的 provider 是否存在。
 * @param {Record<string,object>} agents
 * @param {Record<string,object>} providers
 * @returns {Array<{agent, problems: string[]}>}  有问题的 profile 列表（无问题返回 []）
 */
export function validateAgentsConfig(agents = {}, providers = {}) {
  const knownExecutors = new Set(Object.keys(EXECUTORS))
  const out = []
  for (const [name, profile] of Object.entries(agents)) {
    const problems = []
    if (!profile || typeof profile !== 'object') {
      out.push({ agent: name, problems: ['profile 不是对象'] })
      continue
    }
    if (!profile.executor) problems.push('缺少 executor 字段')
    else if (!knownExecutors.has(profile.executor)) {
      problems.push(`executor '${profile.executor}' 不在已知列表（${[...knownExecutors].join(' / ')}）`)
    }
    if (profile.provider && !providers[profile.provider]) {
      problems.push(`引用的 provider '${profile.provider}' 未在 providers 配置中定义`)
    }
    if (problems.length) out.push({ agent: name, problems })
  }
  return out
}

/**
 * 校验 providers map 里的 ${ENV} 是否能在当前 env 展开。
 * @param {Record<string,object>} providers
 * @param {object} [env]
 * @returns {Array<{provider, problems: string[]}>}
 */
export function validateProvidersConfig(providers = {}, env = process.env) {
  const out = []
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') continue
    const problems = []
    if (typeof p.apiKey === 'string' && p.apiKey.includes('${')) {
      try { interpolateEnv(p.apiKey, env) }
      catch (e) { problems.push(e instanceof ConfigError ? e.message : String(e)) }
    }
    if (problems.length) out.push({ provider: name, problems })
  }
  return out
}

/**
 * 扫描配置层：加载 ~/.flowcast + <repo>/.flowcast 的 agents/providers，校验合法性。
 * @param {object} [opts]
 * @param {string} [opts.repo]
 * @param {object} [opts.env]
 * @returns {Promise<{agentsPath?: string, providersPath?: string, agents, providers, agentProblems, providerProblems}>}
 */
export async function scanConfig({ repo, env = process.env } = {}) {
  const [agents, providers] = await Promise.all([
    loadAgents({ repo }),
    loadProviders({ repo }),
  ])
  return {
    agents,
    providers,
    agentProblems: validateAgentsConfig(agents, providers),
    providerProblems: validateProvidersConfig(providers, env),
  }
}

/**
 * 全量扫描：CLI 可达性 + 配置合法性 + flowcast 包可解析性。
 * @param {object} [opts]
 * @param {string}  [opts.repo]
 * @param {object}  [opts.deps]  { which, env, home, exists, stat }
 * @returns {Promise<object>}  { agents, config, flowcastResolvable, summary }
 */
export async function fullScan({ repo = process.cwd(), deps = {} } = {}) {
  const agents = await scanAgents(deps)
  const config = await scanConfig({ repo, env: deps.env })
  // flowcast 包可解析性：延迟 import 避免循环依赖（checkFlowcastResolvable 在 orchestrator）
  const { checkFlowcastResolvable } = await import('./orchestrator/run.js')
  const resolveResult = checkFlowcastResolvable(repo)

  const readyCount = agents.filter(a => a.ready).length
  return {
    agents,
    config,
    flowcastResolvable: resolveResult,
    summary: {
      totalClis: agents.length,
      installedClis: agents.filter(a => a.installed).length,
      readyClis: readyCount,
      hasUsableAgent: readyCount > 0,
      configOk: config.agentProblems.length === 0 && config.providerProblems.length === 0,
    },
  }
}

export { BYO_LLM_CLIS }
