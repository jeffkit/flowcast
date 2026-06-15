// provider.js — flowcast 标准 provider profile
//
// 把「用哪个模型/端点/密钥」从 flow 里抽出来，做成声明式、可多层覆盖、密钥不入仓的配置。
// 执行器 adapter（recursive/claude/…）只消费解析后的通用 bundle，不认识具体 provider 名字。
//
// 配置来源（后者覆盖前者）：
//   1. ~/.flowcast/providers.{json,yaml,yml,js,mjs}     —— 机器级（向后兼容 ~/.flowx/）
//   2. <repo>/.flowcast/providers.{json,yaml,yml,js,mjs} —— 项目级覆盖（向后兼容 .flowx/）
//
// 配置形态（canonical）：
//   { "providers": { "deepseek": {
//       "type": "openai",                       // 协议族：openai | anthropic
//       "apiBase": "https://api.deepseek.com/v1",
//       "model": "deepseek-v4-pro",
//       "apiKey": "${DEEPSEEK_API_KEY}"          // ${VAR} 运行时从 env 展开，明文永不入仓
//   } } }
// 兼容旧字段：base→apiBase、keyEnv→apiKey:"${keyEnv}"。

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { flowcastDir } from './dirs.js'

/** 给定配置文件 stem，返回按优先级排列的候选文件名。 */
export function basenamesFor(stem) {
  return [`${stem}.json`, `${stem}.yaml`, `${stem}.yml`, `${stem}.js`, `${stem}.mjs`]
}

/**
 * ${VAR} 插值（移植 ilink-hub env-interpolation-spec）：
 *  - 仅识别 ${IDENT}，IDENT = [A-Za-z_][A-Za-z0-9_]*
 *  - `$$` → 字面 `$`（不递归、不查 env）
 *  - 缺失变量 fail-fast；区分「显式空串」（合法）与「未定义」（报错）
 *  - 不支持默认值语法 ${VAR:-x}，不递归
 */
export function interpolateEnv(template, env = process.env) {
  if (typeof template !== 'string') return template
  const ESCAPE = '\u0000FLOWCAST_DOLLAR\u0000'
  const withEscapes = template.split('$$').join(ESCAPE)
  const expanded = withEscapes.replace(/\$\{([^}]*)\}/g, (m, ident) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
      throw new Error(`非法插值 token：${m}（仅支持 \${IDENT}）`)
    }
    if (!(ident in env)) {
      throw new Error(`环境变量 ${ident} 未设置（插值 ${m} 失败，来自模板：${template.slice(0, 80)}）`)
    }
    return env[ident]
  })
  return expanded.split(ESCAPE).join('$')
}

async function loadConfigFile(file) {
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`解析配置文件失败 ${file}：${e.message}`)
    }
  }
  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    const mod = await import(pathToFileURL(file).href)
    return mod.default ?? mod.providers ?? mod
  }
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    let YAML
    try {
      const m = await import('yaml')
      YAML = m.default ?? m
    } catch {
      throw new Error(`解析 ${file} 需要 yaml 包（npm i yaml），或改用 providers.json`)
    }
    return YAML.parse(readFileSync(file, 'utf8'))
  }
  throw new Error(`不支持的 provider 配置类型：${file}`)
}

/**
 * 通用多层配置加载：~/.flowcast → <repo>/.flowcast，后者覆盖前者（向后兼容 .flowx/）。
 * @param {string[]} basenames  候选文件名（见 basenamesFor）
 * @param {object} [o]
 * @param {string} [o.repo]   项目根（查找 <repo>/.flowcast/*，向后兼容 .flowx/）
 * @param {string[]} [o.dirs] 完全覆盖默认搜索目录（测试用）
 * @param {string} [o.key]    顶层 section key（如 'providers' / 'agents'）；文件可写 {key:{...}} 或裸 {...}
 * @returns {Promise<Record<string, object>>}
 */
export async function loadMergedConfig(basenames, { repo, dirs, key } = {}) {
  // 机器级：~/.flowx 在前（旧配置基准），~/.flowcast 在后（新配置覆盖），两者都搜索。
  // 旧逻辑「目录存在就选 .flowcast 否则选 .flowx」有缺陷：~/.flowcast/dryrun/ 存在就会
  // 完全跳过 ~/.flowx/ 里的真实配置。现在改为两个目录都纳入 merge 链，后者覆盖前者，
  // 向后兼容：仅有 ~/.flowx/ 的老机器直接继续工作；同时有两者的机器 .flowcast 优先。
  const home = homedir()
  const homeDirs = [join(home, '.flowx'), join(home, '.flowcast')]
  const searchDirs = dirs ?? [...homeDirs, ...(repo ? [flowcastDir(repo)] : [])]
  let merged = {}
  for (const dir of searchDirs) {
    for (const base of basenames) {
      const file = join(dir, base)
      if (existsSync(file)) {
        const cfg = await loadConfigFile(file)
        const section = key ? (cfg?.[key] ?? cfg ?? {}) : (cfg ?? {})
        // 深合并：对顶层每个 key 做对象级合并，而非整段 section 浅覆盖。
        // 场景：~/.flowcast/providers.json 里 deepseek 含 apiKey，
        //       <repo>/.flowcast/providers.json 只想覆盖 deepseek.model——
        //       浅合并会丢失 apiKey，深合并保留机器级字段、只覆盖项目级写明的字段。
        for (const [k, v] of Object.entries(section)) {
          if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
              merged[k] !== null && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
            merged[k] = { ...merged[k], ...v }  // 对象 → 深一层合并
          } else {
            merged[k] = v  // 非对象（字符串/数字/null/数组）→ 直接覆盖
          }
        }
        break // 每个目录只取第一个命中的文件
      }
    }
  }
  return merged
}

/** 加载并合并多层 provider 配置。 */
export async function loadProviders({ repo, dirs } = {}) {
  return loadMergedConfig(basenamesFor('providers'), { repo, dirs, key: 'providers' })
}

/**
 * 把命名 provider 解析为通用 bundle。同步函数（providers map 由调用方先 loadProviders 拿到）。
 * @param {string} name              provider 名
 * @param {Record<string,object>} providers  已加载的 providers map
 * @param {object} [env]             插值用 env（默认 process.env）
 * @returns {{name,type,apiBase,model,apiKey}|null}  name 为空返回 null
 */
export function resolveProvider(name, providers = {}, env = process.env) {
  if (!name) return null
  const p = providers[name]
  if (!p) {
    const known = Object.keys(providers)
    const hint = known.length
      ? `已定义：${known.join(' / ')}`
      : '当前无任何 provider 配置，请创建 ~/.flowcast/providers.json'
    throw new Error(`未知 provider '${name}'（${hint}）`)
  }
  const bundle = {
    name,
    type: p.type,
    apiBase: p.apiBase ?? p.base,
    model: p.model,
    apiKey: p.apiKey ?? (p.keyEnv ? `\${${p.keyEnv}}` : undefined),
  }
  for (const k of ['apiBase', 'model', 'apiKey']) {
    if (typeof bundle[k] === 'string') bundle[k] = interpolateEnv(bundle[k], env)
  }
  return bundle
}
