// orchestrator/decompose.js — 接单分拆：用 LLM 把一个大目标拆成结构化子任务清单。
//
// 受控生成（约束 JSON 形状）+ 跑前校验（parseTasks 校验+规整）+ 失败回喂重试。
// 刻意「不做 DAG」：产出的是一组相互独立、可并行的子任务（与 BACKGROUND 的边界决策一致），
// 由 fanOut 限并发 + worktree 隔离执行；任务间若真有依赖，应拆成多次 orchestrate 调用，而非在此引入编排图。

import { resolveGenerateFn } from './agent-helper.js'

/** 构建分拆提示：要求只输出一个 JSON 数组，每项 {name, goal, agent?}。 */
export function buildDecomposePrompt(goal, { agentsList = [], priorError } = {}) {
  const agentsLine = agentsList.length ? agentsList.join(', ') : '(无预置 agent，留空 agent 字段即可)'
  let p = `You are a task decomposer for the flowcast orchestrator.
Split the BIG GOAL into a flat list of INDEPENDENT sub-tasks that can run in parallel.
Do NOT introduce ordering or dependencies between tasks (no DAG); if two pieces must be sequential, keep them in ONE task.

# Output format (MUST follow)
Output ONLY a JSON array, no prose, no code fence. Each element:
{
  "name": "kebab-case-short-id",      // unique, [a-z0-9-], used as worktree dir & run id
  "goal": "self-contained task goal",  // a complete instruction runnable on its own
  "agent": "<optional agent profile>"  // omit to use the default agent
}

# Available agent profiles
${agentsLine}

# BIG GOAL
${goal}

Output ONLY the JSON array.`
  if (priorError) {
    p += `\n\n# Your previous attempt was REJECTED:\n${priorError}\nFix it and output ONLY the corrected JSON array.`
  }
  return p
}

/**
 * 从 LLM 输出解析+规整+校验子任务清单。
 * @param {string} text
 * @returns {Array<{name:string, goal:string, agent?:string}>}
 * @throws 形状不合法时抛错（供 decompose 回喂重试）
 */
export function parseTasks(text) {
  const match = String(text).match(/\[[\s\S]*\]/)
  if (!match) throw new Error('未找到 JSON 任务数组')
  let raw
  try { raw = JSON.parse(match[0]) } catch (e) { throw new Error(`JSON 解析失败：${e.message}`) }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('任务清单为空')

  const seen = new Map()
  return raw.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`任务 ${i} 不是对象`)
    const goal = String(t.goal ?? '').trim()
    if (!goal) throw new Error(`任务 ${i}（${t.name ?? '?'}）缺少 goal`)

    // name 规整为 kebab-case 安全标识；去重时加序号后缀
    let name = String(t.name ?? `task-${i + 1}`).trim().toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `task-${i + 1}`
    if (seen.has(name)) { const n = seen.get(name) + 1; seen.set(name, n); name = `${name}-${n}` }
    else seen.set(name, 1)

    const task = { name, goal }
    if (t.agent) task.agent = String(t.agent)
    return task
  })
}

/**
 * 把大目标分拆成子任务清单（LLM 生成 → 校验 → 失败回喂重试）。
 * @param {string} goal
 * @param {object} o  repo / agent / agents / providers / generate(注入测试用) / maxAttempts
 * @returns {Promise<{tasks:Array, attempts:number}>}
 */
export async function decompose(goal, {
  repo = process.cwd(), agent, agents = {}, providers = {}, generate, maxAttempts = 2,
} = {}) {
  const agentsList = Object.keys(agents)
  const gen = resolveGenerateFn({ agent, agents, providers, repo, generate, context: 'orchestrate --split' })

  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = buildDecomposePrompt(goal, { agentsList, priorError: lastErr })
    try {
      return { tasks: parseTasks(await gen(prompt)), attempts: attempt }
    } catch (e) {
      lastErr = e.message
    }
  }
  throw new Error(`decompose 失败（${maxAttempts} 次尝试）：${lastErr}`)
}
