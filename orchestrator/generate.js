// orchestrator/generate.js — 受控 flow 代码生成（护栏①）
//
// 用 agent 在 flowx 词汇表内生成一个 flow 文件 → 校验 → 失败把错误回喂、重生成一次。
// 生成产物落 .mjs（ESM 语义无歧义），写进 run 目录持久化。

import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { resolveAgent } from '../executor.js'
import { validateFlow } from './validate.js'
import { FLOW_API_DOC, GOLDEN_SAMPLE } from './paths.js'

/** 从 LLM 输出里抽取代码：优先 ```js 代码块，否则整段。 */
export function extractCode(text) {
  const fence = String(text).match(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/)
  return (fence ? fence[1] : String(text)).trim()
}

/** 构建生成提示：契约 + 黄金样例 few-shot + 可用 agents + 任务。 */
export function buildGenPrompt(request, { agentsList = [], priorError } = {}) {
  const contract = readFileSync(FLOW_API_DOC, 'utf8')
  const golden = readFileSync(GOLDEN_SAMPLE, 'utf8')
  const agentsLine = agentsList.length ? agentsList.join(', ') : '(无预置 agent，运行时用 --agent 指定)'
  let p = `You are a flowx flow generator. Output ONE complete ESM JavaScript flow file.

# Contract (MUST follow)
${contract}

# Golden example (mirror this structure)
\`\`\`js
${golden}
\`\`\`

# Available agent profiles
${agentsLine}

# Task
${request}

Output ONLY the flow code in a single \`\`\`js code block. No explanation.`
  if (priorError) {
    p += `\n\n# Your previous attempt FAILED validation:\n${priorError}\nFix it and output ONLY the corrected flow code.`
  }
  return p
}

/**
 * 生成并校验一个 flow。
 * @param {string} request  自然语言需求
 * @param {object} o
 *   - repo, runDir（必填，落盘目录）
 *   - agent          生成用 agent profile 名（默认 'claude-sonnet'）
 *   - agents, providers
 *   - generate       可注入的生成函数 (prompt)=>Promise<text>（测试用，省去真实 LLM）
 *   - maxAttempts    默认 2（生成 + 失败回喂重试一次）
 * @returns {Promise<{file,code,attempts,validation}>}
 */
export async function generateFlow(request, {
  repo = process.cwd(),
  runDir,
  agent = 'claude-sonnet',
  agents = {},
  providers = {},
  generate,
  maxAttempts = 2,
} = {}) {
  if (!runDir) throw new Error('generateFlow 需要 runDir')
  mkdirSync(runDir, { recursive: true })
  const file = join(runDir, 'flow.mjs')
  const agentsList = Object.keys(agents)

  const gen = generate ?? (async (prompt) => {
    const a = resolveAgent(agent, agents, { providers })
    return String(await a.run(prompt, { cwd: repo, ...a.opts }))
  })

  let validation
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildGenPrompt(request, { agentsList, priorError: validation?.error })
    const code = extractCode(await gen(prompt))
    writeFileSync(file, code, 'utf8')
    validation = await validateFlow(file, { cwd: repo })
    if (validation.ok) return { file, code, attempts: attempt, validation }
  }
  return { file, code: readFileSync(file, 'utf8'), attempts: maxAttempts, validation }
}
