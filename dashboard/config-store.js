// dashboard/config-store.js — agent/provider 配置的读写原语。
//
// 职责：读写某一「层」的 agents.json / providers.json（用户级 ~/.flowcast/ 或项目级 <repo>/.flowcast/），
// 带校验 + 备份 + 原子写。读路径不合并多层（编辑要改的是某一层文件本身，而非合并后的视图）。
//
// 安全不变量（与 provider.js / init.js 一致）：
//   - apiKey 永远是 ${ENV_VAR} 引用，绝不接受明文
//   - 写入永远 .bak 备份 + write-rename 原子写
//   - 写完 clearConfigCache()，否则 30s 内读到的还是旧值
//
// 校验复用 scan.js / executor.js 的现有规则，不发明新规则。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname, normalize, isAbsolute } from 'path'
import { homedir } from 'os'

import { clearConfigCache } from '../provider.js'
import { EXECUTORS, sanitizeExtraArgs } from '../executor.js'
import { BYO_LLM_CLIS } from '../scan.js'

/** ${VAR} 引用格式：只接受大写字母/数字/下划线，必须用 ${} 包裹。明文密钥会被拒绝。 */
const ENV_REF_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/

/** profile 名 / provider 名：字母数字 + - _ .，防路径注入。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// ── 路径解析 ──────────────────────────────────────────────────────

/**
 * 解析目标配置文件路径。
 * @param {'agents'|'providers'} kind
 * @param {{ scope: 'user'|'project', repo?: string, home?: string }} ctx
 * @returns {string} 绝对路径
 */
export function configFilePath(kind, { scope, repo, home }) {
  const base = scope === 'project'
    ? repo
    : (home ?? homedir())
  const dir = scope === 'project'
    ? projectFlowcastDir(base)
    : join(base, '.flowcast')
  return join(dir, `${kind}.json`)
}

// 项目级目录：优先 .flowcast，回退 .flowx（与 dirs.js 的 flowcastDir 语义一致，
// 但这里不引入 dirs.js 的缓存，避免编辑后读到旧缓存路径）。
function projectFlowcastDir(repo) {
  const fc = join(repo, '.flowcast')
  if (existsSync(fc)) return fc
  const legacy = join(repo, '.flowx')
  if (existsSync(legacy)) return legacy
  return fc // 全新项目默认 .flowcast
}

// ── 单层读写（保留未知字段）──────────────────────────────────────

/**
 * 读单个配置文件的原始内容。文件不存在返回空对象。
 * 保留 { agents: {...} } / { providers: {...} } 的外壳 + 任何未知顶层 key（如 "//"、"_comment"）。
 * @param {string} file
 * @param {'agents'|'providers'} section
 * @returns {Record<string, object>} section 内的 map（如 agents map）
 */
export function readConfigLayer(file, section) {
  if (!existsSync(file)) return {}
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    const err = new Error(`配置文件 JSON 解析失败: ${file}: ${e.message}`)
    err.code = 'ECONFIG_PARSE'
    throw err
  }
  // 支持 { agents: {...} } 外壳，也支持裸 {...}
  return raw?.[section] ?? raw ?? {}
}

/**
 * 读整个文件的原始 JSON（含外壳 + 未知 key），用于 read-modify-write。
 * 文件不存在返回 null。
 */
function readRawFile(file) {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 原子写配置文件（write-rename + .bak 备份）。
 * @param {string} file
 * @param {object} raw  完整的文件对象（含外壳）
 */
export function writeConfigLayer(file, raw) {
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  const body = JSON.stringify(raw, null, 2)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${body}\n`)
  renameSync(tmp, file)
  // 配置缓存（provider.js 的 loadMergedConfig 有 30s TTL），写完立即清，否则读到旧值。
  clearConfigCache()
}

/**
 * 把 section map 写回文件（保留外壳 + 未知顶层 key）。
 * 若文件不存在，创建标准外壳 { <section>: {...} }。
 */
function writeSection(file, section, map) {
  const raw = readRawFile(file) ?? {}
  raw[section] = map
  writeConfigLayer(file, raw)
}

// ── Agent profile CRUD ───────────────────────────────────────────

/**
 * 保存（创建或覆盖）一个 agent profile。
 * @param {{ name: string, profile: object, scope: 'user'|'project', repo?: string, home?: string }} args
 * @returns {{ name: string, profile: object }}
 */
export function saveAgentProfile({ name, profile, scope, repo, home }) {
  assertProfileName(name)
  const cleaned = cleanAgentProfile(profile)
  validateAgentProfile(cleaned)
  const file = configFilePath('agents', { scope, repo, home })
  const agents = readConfigLayer(file, 'agents')
  agents[name] = cleaned
  writeSection(file, 'agents', agents)
  return { name, profile: cleaned }
}

/**
 * 删除一个 agent profile。不存在时幂等（不报错）。
 * @returns {{ name: string, deleted: boolean }}
 */
export function deleteAgentProfile({ name, scope, repo, home }) {
  assertProfileName(name)
  const file = configFilePath('agents', { scope, repo, home })
  const agents = readConfigLayer(file, 'agents')
  if (!(name in agents)) return { name, deleted: false }
  delete agents[name]
  writeSection(file, 'agents', agents)
  return { name, deleted: true }
}

// ── Provider CRUD ────────────────────────────────────────────────

/**
 * 保存（创建或覆盖）一个 provider。
 * @param {{ name: string, provider: object, scope, repo?, home? }} args
 */
export function saveProvider({ name, provider, scope, repo, home }) {
  assertProfileName(name)
  const cleaned = cleanProvider(provider)
  validateProvider(cleaned)
  const file = configFilePath('providers', { scope, repo, home })
  const providers = readConfigLayer(file, 'providers')
  providers[name] = cleaned
  writeSection(file, 'providers', providers)
  return { name, provider: cleaned }
}

/**
 * 删除一个 provider。不存在时幂等。
 */
export function deleteProvider({ name, scope, repo, home }) {
  assertProfileName(name)
  const file = configFilePath('providers', { scope, repo, home })
  const providers = readConfigLayer(file, 'providers')
  if (!(name in providers)) return { name, deleted: false }
  delete providers[name]
  writeSection(file, 'providers', providers)
  return { name, deleted: true }
}

// ── 校验 + 清洗 ──────────────────────────────────────────────────

function assertProfileName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    const err = new Error(`非法名称: ${name}（只允许字母数字、- _ .，且不以 . 开头）`)
    err.code = 'EBAD_NAME'
    throw err
  }
}

/**
 * 清洗 agent profile：只保留白名单字段，过滤 extraArgs。
 * 与 executor.js 的 SAFE_OPTS_KEYS + META_KEYS 对齐。
 */
function cleanAgentProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw makeErr('profile 必须是对象', 'EBAD_PROFILE')
  }
  const executor = profile.executor
  if (!executor) throw makeErr('缺少 executor 字段', 'EBAD_EXECUTOR')

  // 白名单字段提取（与 executor.js 的 SAFE_OPTS_KEYS + META_KEYS 一致）
  const out = { executor }
  for (const k of ['provider', 'model', 'timeout', 'maxSteps', 'allowTools', 'transcriptOut', 'pricingFile', 'files', 'cwd']) {
    if (profile[k] !== undefined) out[k] = profile[k]
  }
  // extraArgs：走 executor 的白名单过滤
  if (Array.isArray(profile.extraArgs)) {
    const filtered = sanitizeExtraArgs(executor, profile.extraArgs)
    if (filtered.length) out.extraArgs = filtered
  }
  // 保留 _comment（约定字段，init 会写）
  if (typeof profile._comment === 'string') out._comment = profile._comment
  return out
}

function validateAgentProfile(profile) {
  // executor 必须已知
  if (!EXECUTORS[profile.executor]) {
    throw makeErr(`executor '${profile.executor}' 不在已知列表（${Object.keys(EXECUTORS).join(' / ')}）`, 'EBAD_EXECUTOR')
  }
  // provider 仅 BYO-LLM 允许
  if (profile.provider && !BYO_LLM_CLIS.has(profile.executor)) {
    throw makeErr(`executor '${profile.executor}' 不支持自定义 provider（仅 BYO-LLM: ${[...BYO_LLM_CLIS].join(' / ')}）`, 'EBYD_NOT_ALLOWED')
  }
  // 路径类字段必须相对、无 ..、无前导 /
  for (const k of ['transcriptOut', 'pricingFile', 'cwd']) {
    if (profile[k] != null && !isSafeRelativePath(profile[k])) {
      throw makeErr(`${k} 必须是相对路径，不能含 .. 或以 / 开头: ${profile[k]}`, 'EBAD_PATH')
    }
  }
  if (Array.isArray(profile.files)) {
    for (const f of profile.files) {
      if (!isSafeRelativePath(f)) throw makeErr(`files 含不安全路径: ${f}`, 'EBAD_PATH')
    }
  }
  // timeout/maxSteps 若给必须是正数
  if (profile.timeout != null && !(Number.isFinite(profile.timeout) && profile.timeout > 0)) {
    throw makeErr('timeout 必须是正数（毫秒）', 'EBAD_TIMEOUT')
  }
  if (profile.maxSteps != null && !(Number.isFinite(profile.maxSteps) && profile.maxSteps > 0)) {
    throw makeErr('maxSteps 必须是正数', 'EBAD_MAXSTEPS')
  }
}

/**
 * 清洗 provider：标准化字段，apiKey 强制 ${ENV} 格式。
 */
function cleanProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw makeErr('provider 必须是对象', 'EBAD_PROVIDER')
  }
  const out = {}
  if (provider.type) out.type = provider.type
  if (provider.apiBase) out.apiBase = provider.apiBase
  if (provider.model) out.model = provider.model
  // apiKey：接受 ${VAR} 形式，也接受裸 VAR 名（自动包成 ${VAR}）
  if (provider.apiKey != null) {
    out.apiKey = normalizeApiKey(provider.apiKey)
  }
  // 兼容旧字段
  if (provider.base && !out.apiBase) out.apiBase = provider.base
  if (provider.keyEnv && !out.apiKey) out.apiKey = `\${${provider.keyEnv}}`
  return out
}

function validateProvider(provider) {
  if (provider.apiKey != null && !ENV_REF_RE.test(provider.apiKey)) {
    throw makeErr(
      `apiKey 必须是 \${ENV_VAR} 引用格式（如 \${DEEPSEEK_API_KEY}），不接受明文密钥`,
      'EPLAINTEXT_KEY',
    )
  }
  if (provider.type && !['openai', 'anthropic'].includes(provider.type)) {
    throw makeErr(`type 只能是 openai 或 anthropic，收到: ${provider.type}`, 'EBAD_TYPE')
  }
}

/**
 * 把用户输入的 apiKey 规范化为 ${VAR} 形式。
 * 接受：${VAR}、VAR（裸名，自动包）。拒绝明文（不符合 ENV_REF_RE 的非 ${} 字符串）。
 */
function normalizeApiKey(input) {
  if (typeof input !== 'string') throw makeErr('apiKey 必须是字符串', 'EBAD_KEY')
  const trimmed = input.trim()
  // 已经是 ${VAR} 形式
  if (ENV_REF_RE.test(trimmed)) return trimmed
  // 裸环境变量名（全大写 + _ + 数字）→ 自动包
  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) return `\${${trimmed}}`
  // 否则视为明文 → 拒绝
  throw makeErr(
    `apiKey 疑似明文密钥。请填环境变量名（如 DEEPSEEK_API_KEY），后端会自动包成 \${...}`,
    'EPLAINTEXT_KEY',
  )
}

function isSafeRelativePath(val) {
  if (typeof val !== 'string' || val === '') return false
  if (isAbsolute(val)) return false
  const norm = normalize(val)
  return !norm.startsWith('..')
}

function makeErr(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 导出给前端用的已知 executor 清单（含 BYO 标记）。 */
export function listKnownExecutors() {
  return Object.keys(EXECUTORS).map(name => ({
    name,
    byoLlm: BYO_LLM_CLIS.has(name),
  }))
}

/** 导出 ENV_REF_RE 供测试断言。 */
export { ENV_REF_RE }
