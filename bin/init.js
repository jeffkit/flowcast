// bin/init.js — `flowcast init`：交互式引导 + 自动扫描，生成 agents/providers 配置。
//
// 用法：
//   flowcast init                 交互式：扫描 → 选 agent → 生成 ~/.flowcast/{agents,providers}.json
//   flowcast init --yes           非交互：用默认值（首个 ready CLI 做默认 agent）
//   flowcast init --scope project 写到 <repo>/.flowcast/ 而非 ~/.flowcast/
//
// 设计：把「根据扫描结果算配置」拆成纯函数 buildConfigFromScan（可单测），
// 交互（readline）和写盘（fs）只是薄壳。密钥一律 ${ENV} 形式，明文永不入仓。

import { createInterface } from 'readline'
import { existsSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fullScan, BYO_LLM_CLIS } from '../scan.js'
import { flowcastDir } from '../dirs.js'

// 每个 CLI 的「推荐 agent profile 名」与默认 model。仅用于生成初始配置的占位。
const DEFAULT_PROFILE_NAME = {
  claude: 'claude',
  cursor: 'cursor-default',
  agent: 'cursor-default',
  gemini: 'gemini',
  codex: 'codex',
  agy: 'agy',
  aider: 'aider',
  recursive: 'recursive',
  opencode: 'opencode',
  deepseek: 'deepseek',
  'qwen-code': 'qwen',
  'kimi-code': 'kimi',
  codebuddy: 'codebuddy',
  pi: 'pi',
}

const DEFAULT_MODEL = {
  claude: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-pro',
  codex: 'gpt-5',
  agy: 'auto',
  cursor: 'auto',
  agent: 'auto',
}

/**
 * 根据扫描结果 + 选中的 CLI 集合，生成 agents / providers 配置对象（纯函数）。
 * 不读不写磁盘，便于单测。
 *
 * @param {object} scanResult       fullScan() 的结果
 * @param {object} selection        用户选择
 * @param {string[]} selection.clis 要生成 profile 的 CLI 名列表
 * @param {string}   selection.defaultCli  默认 agent 用哪个 CLI
 * @param {Record<string,{providerName?:string, type?:string, apiBase?:string, apiKeyEnv?:string, model?:string}>} [selection.providers]
 *        按 CLI 名提供 provider 详情（仅 BYO-LLM CLI 需要）
 * @returns {{agents: object, providers: object}}
 */
export function buildConfigFromScan(scanResult, selection) {
  const agents = {}
  const providers = {}

  for (const cli of selection.clis) {
    const found = scanResult.agents.find(a => a.cli === cli)
    if (!found) continue
    const name = DEFAULT_PROFILE_NAME[cli] ?? cli
    const profile = { executor: cli }
    if (DEFAULT_MODEL[cli]) profile.model = DEFAULT_MODEL[cli]

    // BYO-LLM CLI：若用户给了 provider 详情，挂上 provider + 生成 provider 条目
    const provDetail = selection.providers?.[cli]
    if (found.acceptsProvider && provDetail?.apiKeyEnv) {
      const pname = provDetail.providerName || `${cli}-default`
      profile.provider = pname
      providers[pname] = {
        type: provDetail.type || 'openai',
        ...(provDetail.apiBase ? { apiBase: provDetail.apiBase } : {}),
        ...(provDetail.model ? { model: provDetail.model } : {}),
        apiKey: `\${${provDetail.apiKeyEnv}}`,
      }
    }
    agents[name] = profile
  }

  return { agents, providers }
}

// ── readline 交互辅助 ────────────────────────────────────────────────────

function ask(rl, question, { default: dft } = {}) {
  const prompt = dft != null ? `${question} [${dft}]: ` : `${question}: `
  return new Promise(resolve => rl.question(prompt, ans => {
    const v = (ans || '').trim()
    resolve(v === '' && dft != null ? String(dft) : v)
  }))
}

function askBool(rl, question, dft = true) {
  return ask(rl, question, { default: dft ? 'Y/n' : 'y/N' }).then(ans => {
    const a = ans.toLowerCase()
    if (a === 'y' || a === 'yes') return true
    if (a === 'n' || a === 'no') return false
    return dft
  })
}

// ── 渲染扫描结果表格 ─────────────────────────────────────────────────────

export function renderScanTable(scanResult) {
  const lines = []
  lines.push('')
  lines.push('本机 agent CLI 扫描结果：')
  lines.push('  CLI          已装  凭证    可用')
  lines.push('  ───────────  ────  ──────  ────')
  for (const a of scanResult.agents) {
    const installed = a.installed ? '✓' : '✗'
    const auth = a.authed === true ? '✓' : a.authed === false ? '✗' : '?'
    const ready = a.ready ? '✓' : '✗'
    lines.push(`  ${a.cli.padEnd(12)}  ${installed.padEnd(4)}  ${auth.padEnd(6)}  ${ready}`)
  }
  lines.push('')
  return lines.join('\n')
}

// ── 写盘（带备份） ────────────────────────────────────────────────────────

function writeJsonWithBackup(file, obj) {
  if (existsSync(file)) {
    copyFileSync(file, `${file}.bak`)
  }
  mkdirSync(dirname(file), { recursive: true })
  // 保留 // 引导注释的头部（与 examples 风格一致）
  const body = JSON.stringify(obj, null, 2)
  writeFileSync(file, `${body}\n`)
}

/**
 * 运行 `flowcast init`。
 * @param {string[]} argv
 * @param {object} [injected]  测试用注入：{ scan, input, out }
 * @returns {Promise<number>}  退出码
 */
export async function runInit(argv = [], injected = {}) {
  const yes = argv.includes('--yes') || argv.includes('-y')
  const scopeProject = argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] === 'project' : false
  const repo = process.cwd()
  const { out = process.stdout } = injected

  // 目标目录：默认 ~/.flowcast/（机器级）；--scope project → <repo>/.flowcast/
  const targetDir = scopeProject
    ? flowcastDir(repo)
    : join(homedir(), '.flowcast')
  const agentsFile = join(targetDir, 'agents.json')
  const providersFile = join(targetDir, 'providers.json')

  // 扫描（真实或注入）；注入模式下不再重复扫描/渲染
  const scanResult = injected.scan ?? await fullScan({ repo })
  out.write(renderScanTable(scanResult))

  const readyClis = scanResult.agents.filter(a => a.ready && a.installed)
  if (readyClis.length === 0) {
    out.write('✗ 没有发现任何「已装且可用」的 agent CLI。\n')
    out.write('  请先安装至少一个（如 `npm i -g @anthropic-ai/claude-code`），再重跑 `flowcast init`。\n')
    return 1
  }

  let selection
  if (yes) {
    // 非交互：选所有 ready CLI，第一个做默认
    selection = {
      clis: readyClis.map(a => a.cli),
      defaultCli: readyClis[0].cli,
      providers: {},
    }
  } else if (injected.input) {
    // 测试注入的选择
    selection = injected.input
  } else {
    selection = await interactiveSelect(scanResult, readyClis, { out })
  }

  const { agents, providers } = buildConfigFromScan(scanResult, selection)

  // 合并已有配置（不覆盖用户已有条目，仅增量补充）
  const merged = mergeIntoExisting(agentsFile, providersFile, agents, providers)

  writeJsonWithBackup(agentsFile, merged.agents)
  if (Object.keys(merged.providers).length > 0) {
    writeJsonWithBackup(providersFile, merged.providers)
  }

  // 输出结果
  out.write(`\n✓ 配置已写入 ${targetDir}/\n`)
  out.write(`  agents:    ${Object.keys(merged.agents).join(', ')}\n`)
  if (Object.keys(merged.providers).length > 0) {
    out.write(`  providers: ${Object.keys(merged.providers).join(', ')}\n`)
  }
  out.write(`  默认 agent 推荐：${DEFAULT_PROFILE_NAME[selection.defaultCli] ?? selection.defaultCli}\n`)
  out.write('\n下一步：\n')
  out.write(`  flowcast orchestrate "<你的需求>" --repo . --agent ${DEFAULT_PROFILE_NAME[selection.defaultCli] ?? selection.defaultCli}\n`)
  out.write('  flowcast doctor          # 复查环境\n')
  return 0
}

/**
 * 交互式选择：让用户勾选要生成 profile 的 CLI、选默认、给 BYO-LLM CLI 补 provider。
 */
async function interactiveSelect(scanResult, readyClis, { out }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    out.write('选择要生成 agent profile 的 CLI（输入序号，逗号分隔，回车=全选）：\n')
    readyClis.forEach((a, i) => {
      const tag = a.acceptsProvider ? '(BYO-LLM，需 provider)' : ''
      out.write(`  [${i}] ${a.cli}  ${tag}\n`)
    })
    const picked = await ask(rl, '选择')
    let chosen
    if (picked === '') {
      chosen = readyClis
    } else {
      const idxs = picked.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      chosen = idxs.map(i => readyClis[i]).filter(Boolean)
    }
    if (chosen.length === 0) chosen = readyClis

    // 默认 agent
    out.write('\n')
    const defaultName = await ask(rl, '默认 agent 用哪个 CLI', { default: chosen[0].cli })
    const defaultCli = chosen.find(a => a.cli === defaultName) ? defaultName : chosen[0].cli

    // BYO-LLM CLI：追问 provider
    const providers = {}
    for (const a of chosen) {
      if (!a.acceptsProvider) continue
      out.write(`\n${a.cli} 需要 provider（BYO-LLM）。\n`)
      const want = await askBool(rl, '现在配置 provider 吗？', false)
      if (!want) continue
      const apiKeyEnv = await ask(rl, 'API Key 的环境变量名（如 ANTHROPIC_API_KEY）')
      if (!apiKeyEnv) continue
      const type = await ask(rl, '协议类型', { default: 'openai' })
      const apiBase = await ask(rl, 'API Base URL（可留空）')
      const model = await ask(rl, '默认 model（可留空）')
      providers[a.cli] = {
        ...(apiBase ? { apiBase } : {}),
        ...(model ? { model } : {}),
        apiKeyEnv,
        type,
      }
    }

    return { clis: chosen.map(a => a.cli), defaultCli, providers }
  } finally {
    rl.close()
  }
}

/**
 * 把生成的配置合并进已有文件（已有条目保留，新条目增量加入）。
 */
function mergeIntoExisting(agentsFile, providersFile, newAgents, newProviders) {
  let existingAgents = {}
  let existingProviders = {}
  try {
    if (existsSync(agentsFile)) existingAgents = JSON.parse(readFileSync(agentsFile, 'utf8')).agents ?? {}
  } catch { /* 损坏的旧文件，忽略 */ }
  try {
    if (existsSync(providersFile)) existingProviders = JSON.parse(readFileSync(providersFile, 'utf8')).providers ?? {}
  } catch { /* 同上 */ }

  return {
    agents: { ...newAgents, ...existingAgents },  // 已有的优先（不覆盖用户手改）
    providers: { ...newProviders, ...existingProviders },
  }
}
