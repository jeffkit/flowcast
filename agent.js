import { spawn } from 'child_process'
import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isDryRun } from './dry-run.js'

// ── 底层 CLI 调用 ─────────────────────────────────────────────────

function spawnCli(cli, args, cwd, timeout, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cli, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })

    const timer = setTimeout(() => {
      proc.kill()
      const err = new Error(`[${cli}] timeout after ${timeout}ms`)
      err.timedOut = true
      reject(err)
    }, timeout)

    proc.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`[${cli}] exit ${code}\n${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}

// ── CLI 封装：各 Agent ────────────────────────────────────────────

/**
 * 把通用 provider bundle（见 provider.js resolveProvider）翻译成 claude Code 读取的
 * ANTHROPIC_* 环境变量，让 claude 走自定义网关（deepseek/minimax 等 anthropic 兼容端点）。
 * 只接受 anthropic 协议族 provider；apiKey 已由上层从 ${VAR} 插值好（明文不入仓）。
 * @param {{type?,apiBase?,apiKey?,model?}} [provider]
 * @returns {Record<string,string>|undefined}
 */
export function claudeProviderEnv(provider) {
  if (!provider) return undefined
  if (provider.type && provider.type !== 'anthropic') {
    throw new Error(`claude adapter 只支持 anthropic 协议 provider，收到 type=${provider.type}`)
  }
  const env = {}
  if (provider.apiBase) env.ANTHROPIC_BASE_URL = provider.apiBase
  if (provider.apiKey) env.ANTHROPIC_AUTH_TOKEN = provider.apiKey
  return Object.keys(env).length ? env : undefined
}

// provider 限额/超载错误 → 可回退到下一个 provider。
const RETRYABLE_PROVIDER_ERR = /rate.?limit|session limit|too many requests|quota|overloaded|\b429\b|\b529\b/i
// 超时（卡死/慢）也应回退到下一个 agent——靠 err.timedOut 结构化标记，不靠 message 文本匹配，避免误判。
export function isProviderRetryable(err) {
  return err?.timedOut === true ||
    err?.apiStatus === 429 || err?.apiStatus === 529 ||
    RETRYABLE_PROVIDER_ERR.test(err?.message ?? '')
}

/**
 * 单次 claude 调用。用 spawnCapture（不因非零退出 reject），这样 claude 因 429/限额
 * 退出非零时，仍能从 stdout 的 result JSON 里读出 api_error_status，供回退判断。
 */
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
 * 输出格式：JSON 数组，取 type=result 条目的 result 字段
 * provider（可选）：anthropic 兼容网关 bundle，注入 ANTHROPIC_BASE_URL/_AUTH_TOKEN。
 * providerFallbacks（可选）：主 provider 限额/超载时按序回退的 bundle 列表。
 */
export async function claude(prompt, {
  cwd = process.cwd(), model, timeout = 300_000, extraArgs = [], provider, providerFallbacks = [],
} = {}) {
  // provider 链：主 + 回退；空链表示用 ambient env（claude 自身配置）。
  const chain = [provider, ...providerFallbacks].filter(p => p != null)
  if (chain.length === 0) chain.push(undefined)
  let lastErr
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]
    try {
      // 回退到不同 provider 时，模型必须跟随该 provider（CLI --model 显式覆盖除外）。
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

/**
 * Gemini CLI  (gemini -p ...)
 * https://github.com/google-gemini/gemini-cli
 * 输出格式：纯文本
 */
export async function gemini(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('gemini', args, cwd, timeout)
  return raw.trim()
}

/**
 * Codex CLI  (codex exec ...)
 * https://github.com/openai/codex
 * 自管鉴权（codex login），不接受外部 provider。
 * 用 codex exec 非交互模式；stdout 含事件日志噪声，故用 --output-last-message
 * 把最终回复写到临时文件，读出干净结果（拿不到则回退 stdout）。
 */
export async function codex(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const outFile = join(tmpdir(), `flowx-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
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

/**
 * agy CLI  (agy -p ...)
 * 自带鉴权的编译型 coding agent CLI，不接受外部 provider。
 * 非交互单次执行用 -p/--print；prompt 为位置参数；输出纯文本。
 * 需要自动放行工具权限时，在 extraArgs 里加 --dangerously-skip-permissions。
 */
export async function agy(prompt, { cwd = process.cwd(), model, timeout = 300_000, extraArgs = [] } = {}) {
  const args = ['-p', prompt]
  if (model) args.push('--model', model)
  args.push(...extraArgs)
  const raw = await spawnCli('agy', args, cwd, timeout)
  return raw.trim()
}

/**
 * Aider  (aider --message ...)
 * https://aider.chat
 * 适合机械性批量修改，在已有 git repo 里直接 commit
 */
export async function aider(prompt, { cwd = process.cwd(), model, files = [], timeout = 600_000, extraArgs = [] } = {}) {
  const args = ['--message', prompt, '--yes-always', '--no-pretty']
  if (model) args.push('--model', model)
  args.push(...files, ...extraArgs)
  const raw = await spawnCli('aider', args, cwd, timeout)
  return raw.trim()
}

/**
 * Cursor Agent CLI  (agent -p ...)
 * 输出格式：单个 JSON 对象，result 字段是结果
 * 注意：首次在新目录运行需要 workspace trust 确认，建议在项目目录预先运行一次交互模式
 */
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

// ── recursive 执行器 adapter ──────────────────────────────────────
//
// recursive（github.com/jeffkit/recursive）是一个极简的 Rust coding agent
// kernel，自身能在 worktree 里改自己的源码。在 flowx 里它只是一个「执行器」：
// 把它当子进程 spawn，run/replay 一个 goal。
//
// 与 claude/cursor adapter 的关键区别：
//   recursive 的 **exit code 是数据，不是错误**（0=正常结束、1=失败、
//   101=panic、128+N=信号、BudgetExceeded 也以非零退出）。因此这里用
//   spawnCapture 不抛错，把 exit code / finishReason / budgetExceeded /
//   transcript 长度全部放进 _meta，交给上层 flow 决策。

/**
 * 捕获式 spawn：不因非零退出码 reject。合并 stdout+stderr（对齐 self-improve.sh 的 2>&1）。
 * 返回 { stdout, exitCode, timedOut, spawnError? }。
 */
export function spawnCapture(cmd, args, { cwd = process.cwd(), timeout, env, onData } = {}) {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ stdout: `[spawn error] ${err.message}`, exitCode: -1, timedOut: false, spawnError: err.message })
      return
    }
    let out = ''
    let timedOut = false
    const append = d => { const s = d.toString(); out += s; onData?.(s) }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    const timer = timeout ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL') }, timeout) : null
    proc.on('error', err => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: out + `\n[spawn error] ${err.message}`, exitCode: -1, timedOut, spawnError: err.message })
    })
    proc.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ stdout: out, exitCode: code ?? -1, timedOut })
    })
  })
}

/** 解析 recursive 二进制路径：优先 release，其次 debug，最后回退 PATH 上的 recursive。 */
export function resolveRecursiveBin(cwd = process.cwd()) {
  for (const p of ['target/release/recursive', 'target/debug/recursive']) {
    if (existsSync(join(cwd, p))) return join(cwd, p)
  }
  return 'recursive'
}

/**
 * recursive 执行器。
 *
 * @param {string} goal 目标文本（run 模式）或续跑时追加的提示（replay 模式）
 * @param {object} opts
 *   - cwd              工作目录（也是 --workspace 的解析基准）
 *   - bin              recursive 二进制路径（默认自动解析 cwd 下的 target/）
 *   - workspace        --workspace 值（默认 '.'）
 *   - systemPromptFile --system-prompt-file
 *   - transcriptOut    --transcript-out（用于 resume / 统计 transcript 长度）
 *   - pricingFile      --pricing-file
 *   - log              --log 级别（默认 'warn'）
 *   - allowTools       --allow-tools（如 'Read,Glob'，给只读审查用）
 *   - replayFrom       { transcript, resumeFrom } → 走 replay 子命令
 *   - env              额外环境变量（合并进 process.env，flow 用它设 provider/model/budget）
 *   - timeout          硬超时 ms（默认 30min，对齐 recursive HARD_TIMEOUT）
 *   - onData           流式输出回调（用于 watchdog / tee 日志）
 * @returns {Promise<String & {_meta}>} stdout 字符串，附 _meta
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
  if (provider) args.push('--provider', provider)   // openai | anthropic（协议类型）
  if (model) args.push('--model', model)
  if (apiKey) args.push('--api-key', apiKey)
  if (apiBase) args.push('--api-base', apiBase)
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

  // panic 判定：Rust panic 默认 exit 101，信号 128+N。
  const panicked = exitCode === 101 || (typeof exitCode === 'number' && exitCode >= 128)

  let transcriptMessages = 0
  if (transcriptOut && existsSync(transcriptOut)) {
    try {
      transcriptMessages = JSON.parse(readFileSync(transcriptOut, 'utf8')).messages?.length ?? 0
    } catch { /* transcript 可能未写完 / 非 JSON，忽略 */ }
  }

  return Object.assign(String(stdout), {
    _meta: { cli: 'recursive', exitCode, timedOut, spawnError, budgetExceeded, finishReason, panicked, transcriptMessages },
  })
}

/**
 * 把通用 provider bundle（见 provider.js resolveProvider）翻译成 recursive 二进制读取的
 * RECURSIVE_* 环境变量。RECURSIVE_* 这套名字是 recursive 的协议约定（与 self-improve.sh 一致），
 * 属于 recursive adapter 的知识，故放这里而非通用 provider 层。
 * @param {{type?,apiBase?,model?,apiKey?,maxSteps?}} [bundle]
 * @returns {Record<string,string>} 可直接并入子进程 env
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

// ── 通用 runAgent：根据 cli 参数路由到对应封装 ────────────────────

// agent 是 cursor-agent CLI（二进制名就叫 agent），cursor adapter 已封装它 → 别名复用。
const CLI_MAP = { claude, gemini, codex, aider, cursor, recursive, agy, agent: cursor }

let _defaultCwd = process.cwd()

/** 设置全局默认工作目录，flow 启动时调用一次，之后所有 runAgent 自动继承 */
export function setWorkdir(dir) {
  _defaultCwd = dir
}

// ── 观测事件 sink（与 setWorkdir/setHitlBackend 同款模块级注入）────────
//
// provider/CLI 回退这类「可观测信号」原本只打到 stdout，结构化数据里丢了。
// flow 启动时用 setAgentEventSink(e => cp.event(...)) 注入一次，回退发生时
// 就把 {event:'fallback',...} 写进 run.log.jsonl，看板据此算 fallback 率。
// 默认 null（不注入则零开销）；emit 吞掉异常——观测绝不能影响主流程。
let _agentEventSink = null

/** 注入 agent 观测事件回调（fallback 等）。传非函数即清空。 */
export function setAgentEventSink(fn) {
  _agentEventSink = typeof fn === 'function' ? fn : null
}

function emitAgentEvent(e) {
  if (!_agentEventSink) return
  try { _agentEventSink(e) } catch { /* 观测失败不影响主流程 */ }
}

export async function runAgent(prompt, { cli = 'claude', cwd, ...opts } = {}) {
  // dry-run：不真实调用任何 CLI/API，返回假结果让 flow 骨架能空跑（写 flow/改原语时校验流程）。
  if (isDryRun()) return Object.assign(`[dry-run] ${cli} 未真实执行`, { _meta: { cli, dryRun: true } })
  let fn = CLI_MAP[cli]
  if (!fn) {
    // CLI_MAP 未命中时回退查 EXECUTORS（registerExecutor 注册的自定义执行器）。
    // 用动态 import 避免 agent.js ↔ executor.js 的初始化时循环依赖。
    const { EXECUTORS } = await import('./executor.js')
    fn = EXECUTORS[cli]?.run
  }
  if (!fn) throw new Error(`未知 CLI: ${cli}，支持：${Object.keys(CLI_MAP).join('/')}（或通过 registerExecutor 注册的自定义执行器）`)
  const result = await fn(prompt, { cwd: cwd ?? _defaultCwd, ...opts })
  // 把 _meta 暴露出来方便 checkpoint 记录，不影响 result 字符串本身
  return result
}

// 一个 agent spec 的可读标签（cli[/provider]），用于回退日志与冷却键。
function specLabel(spec = {}) {
  return `${spec.cli ?? 'claude'}${spec.provider?.name ? '/' + spec.provider.name : ''}`
}

// run 级冷却：agent 因限额/超时失败后短期降级到链尾，避免每步白白重撞。
// 采用自适应指数退避——首次失败冷却 base（默认 30s），连续失败翻倍、封顶 cap（默认 8min），
// 加 ±10% 抖动避免并发任务同时复活；成功调用清除冷却与失败计数（限额恢复 → 立即回优先位）。
// 这样瞬时抖动只短冷一下，硬限额则越冷越久，不会每 2 分钟固定白撞一次。
// base/cap 可经 env 覆盖（FLOWCAST_AGENT_COOLDOWN_BASE_MS / _MAX_MS），改参数不动代码。
export const AGENT_COOLDOWN_BASE_MS = 30_000
export const AGENT_COOLDOWN_MAX_MS = 480_000

// 不动代码就能调冷却：env 覆盖默认值（无效/缺省时回退内置常量）。
// FLOWCAST_AGENT_COOLDOWN_BASE_MS / FLOWCAST_AGENT_COOLDOWN_MAX_MS（单位 ms，>=0）。
// 向后兼容：FLOWX_AGENT_COOLDOWN_BASE_MS / _MAX_MS 仍被识别（deprecated）。
function envMs(newName, oldName, fallback) {
  const v = parseInt(process.env[newName] ?? process.env[oldName] ?? '', 10)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}
function defaultCooldownBaseMs() { return envMs('FLOWCAST_AGENT_COOLDOWN_BASE_MS', 'FLOWX_AGENT_COOLDOWN_BASE_MS', AGENT_COOLDOWN_BASE_MS) }
function defaultCooldownMaxMs() { return envMs('FLOWCAST_AGENT_COOLDOWN_MAX_MS', 'FLOWX_AGENT_COOLDOWN_MAX_MS', AGENT_COOLDOWN_MAX_MS) }

// 按连续失败次数算退避时长（含 ±10% 抖动）。
function backoffMs(fails, base = AGENT_COOLDOWN_BASE_MS, cap = AGENT_COOLDOWN_MAX_MS) {
  const ms = Math.min(base * 2 ** Math.max(0, fails - 1), cap)
  return Math.round(ms * (0.9 + Math.random() * 0.2))
}

// 该 spec 当前剩余冷却时间（ms）；无冷却 Map 或已过期返回 0。兼容值为数字或 {until,fails}。
function coolRemaining(cooldown, spec, now) {
  if (!cooldown) return 0
  const entry = cooldown.get(specLabel(spec))
  const until = entry && typeof entry === 'object' ? entry.until : entry
  return until && until > now ? until - now : 0
}

/**
 * 跨 CLI 的 agent 链式回退：chain 是一组 runAgent opts，按序尝试，
 * 某个因限额/超载/超时（isProviderRetryable）失败就切下一个（如 claude+minimax → agy → claude+deepseek）。
 * 与 claude adapter 内部的 provider 回退正交：这里能跨不同 CLI 回退。
 *
 * 可选 run 级冷却：传入共享 cooldown（Map<label, {until,fails}>），刚因限额/超时挂掉的 agent
 * 按指数退避降级到链尾（不丢弃，仍可作最后兜底），避免后续每步都先白撞它一次；
 * 成功调用会清除其冷却（限额恢复后自动回到优先位）。
 *
 * @param {string} prompt
 * @param {Array<object>} chain  每个元素是一份 runAgent opts（含 cli/model/provider/...）
 * @param {{runner?:Function, cooldown?:Map, cooldownBaseMs?:number, cooldownMaxMs?:number}} [io]
 */
export async function runAgentChain(prompt, chain, {
  runner = runAgent, cooldown = null,
  cooldownBaseMs = defaultCooldownBaseMs(), cooldownMaxMs = defaultCooldownMaxMs(),
} = {}) {
  const list = Array.isArray(chain) && chain.length ? chain : [{}]
  // 冷却中的 agent 排到末尾（按剩余冷却升序），未冷却的保持原优先级；保证总有可试项。
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
      if (cooldown) cooldown.delete(specLabel(spec))  // 成功 → 清除冷却与失败计数，下次回到优先位
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
  throw lastErr
}

// ── 并发工具 ─────────────────────────────────────────────────────

/**
 * 并行跑多个 thunk（() => Promise）。
 * @param {Array<Function>} thunks
 * @param {object} [o]
 * @param {number} [o.concurrency]  并发上限；缺省 = 全部一起跑。结果按原下标顺序返回。
 * @param {boolean} [o.strict=false]  true：任一失败立即抛错；false（默认）：失败返回 null 不中断整体。
 */
export async function parallel(thunks, { concurrency, strict = false } = {}) {
  const failures = []
  const guard = (fn, i) => fn().catch(err => {
    console.error(`  [parallel error] ${err.message}`)
    if (strict) failures.push({ index: i, error: err })
    return null
  })
  let results
  // 无上限：全部一起跑（向后兼容默认行为）
  if (!concurrency || concurrency >= thunks.length) {
    results = await Promise.all(thunks.map((fn, i) => guard(fn, i)))
  } else {
    // 限并发：worker 池按序消费，结果保持原下标顺序
    results = new Array(thunks.length)
    let next = 0
    const worker = async () => {
      while (next < thunks.length) {
        const i = next++
        results[i] = await guard(thunks[i], i)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
  }
  if (strict && failures.length > 0) {
    const msgs = failures.map(f => `[${f.index}] ${f.error.message}`).join('; ')
    const err = new Error(`parallel: ${failures.length} task(s) failed — ${msgs}`)
    err.failures = failures
    throw err
  }
  return results
}

/** 把 items 依次流经多个 stage，每个 stage 是 async (item) => result */
export async function pipeline(items, ...stages) {
  let current = items
  for (const stage of stages) {
    current = await Promise.all(current.map((item, i) => stage(item, i)))
  }
  return current
}

// ── HITL（可插拔后端：terminal / wecom / 自定义）──────────────────
//
// 一个 HITL backend 是 { waitForInput(prompt) → Promise<string>,
// notify(message) → Promise<void> }。flow 启动时用 setHitlBackend 选定：
//   setHitlBackend('terminal')                 // 默认，readline
//   setHitlBackend('wecom', { ...config })      // 企微（mcp2cli 或注入 sender）
//   setHitlBackend(customBackendObject)         // 直接注入（测试/宿主集成）

/** 终端后端：readline 阻塞等待输入。 */
const terminalBackend = {
  async waitForInput(prompt) {
    const { createInterface } = await import('readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => {
      rl.question(`\n${prompt}\n> `, answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
  },
  async notify(message) {
    console.log(`\n[notify] ${message}\n`)
  },
}

/**
 * 企微后端。两种接法（优先级从高到低）：
 *   1. 注入函数：config.sendAndWait(message, ctx) / config.send(message, ctx)
 *      —— 最易测试、宿主可直接对接 wecom-hil MCP。
 *   2. mcp2cli：shell 调用 wecom-hil MCP 的 send_and_wait_reply / send_message_only。
 * ctx = { projectName, chatId }。
 */
function makeWecomBackend(config = {}) {
  const projectName = config.projectName ?? 'flowcast'
  const chatId = config.chatId ?? null
  const ctx = { projectName, chatId }

  if (typeof config.sendAndWait === 'function' || typeof config.send === 'function') {
    return {
      async waitForInput(prompt) {
        if (typeof config.sendAndWait !== 'function') {
          throw new Error('wecom backend: sendAndWait 未配置，无法等待回复')
        }
        return await config.sendAndWait(prompt, ctx)
      },
      async notify(message) {
        if (typeof config.send === 'function') return void await config.send(message, ctx)
        if (typeof config.sendAndWait === 'function') return // 仅有 sendAndWait 时，notify 退化为 best-effort 跳过
      },
    }
  }

  // mcp2cli 真实实现：调用 wecom-hil MCP 工具。
  const mcp2cli = config.mcp2cli ?? 'mcp2cli'
  const server = config.server ?? '@wecom-hil'
  const callTool = async (tool, message, { wait }) => {
    const payload = JSON.stringify({ message, project_name: projectName, ...(chatId ? { chat_id: chatId } : {}) })
    const { stdout, exitCode } = await spawnCapture(mcp2cli, [server, tool, '--json', payload], { timeout: wait ? 86_400_000 : 60_000 })
    if (exitCode !== 0) throw new Error(`wecom mcp2cli ${tool} exit ${exitCode}: ${stdout.slice(0, 200)}`)
    return stdout
  }
  return {
    async waitForInput(prompt) {
      const out = await callTool('send_and_wait_reply', prompt, { wait: true })
      try {
        const data = JSON.parse(out)
        return data?.replies?.[0]?.content ?? out.trim()
      } catch { return out.trim() }
    },
    async notify(message) {
      await callTool('send_message_only', message, { wait: false }).catch(err => {
        console.warn(`[wecom notify] 失败（忽略）：${err.message}`)
      })
    },
  }
}

let _hitlBackend = terminalBackend

/** 选定 HITL 后端：'terminal' | 'wecom' | 自定义 backend 对象。 */
export function setHitlBackend(backend, config = {}) {
  if (backend && typeof backend === 'object') { _hitlBackend = backend; return }
  if (backend === 'terminal') { _hitlBackend = terminalBackend; return }
  if (backend === 'wecom') { _hitlBackend = makeWecomBackend(config); return }
  throw new Error(`未知 HITL 后端: ${backend}（支持 terminal/wecom/自定义对象）`)
}

/** 当前 HITL 后端（测试 / 调试用）。 */
export function getHitlBackend() { return _hitlBackend }

/** 阻塞等待人类输入（路由到当前后端）。 */
export async function waitForInput(prompt) {
  return _hitlBackend.waitForInput(prompt)
}

/** 单向通知人类，不等待（路由到当前后端；后端无 notify 时回退终端打印）。 */
export async function notify(message) {
  if (typeof _hitlBackend.notify === 'function') return _hitlBackend.notify(message)
  return terminalBackend.notify(message)
}
