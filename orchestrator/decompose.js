// orchestrator/decompose.js — 接单分拆：用 LLM 把一个大目标拆成结构化子任务清单。
//
// 受控生成（约束 JSON 形状）+ 跑前校验（parseTasks 校验+规整）+ 失败回喂重试。
// 刻意「不做 DAG」：产出的是一组相互独立、可并行的子任务（与 BACKGROUND 的边界决策一致），
// 由 fanOut 限并发 + worktree 隔离执行；任务间若真有依赖，应拆成多次 orchestrate 调用，而非在此引入编排图。

import { resolveGenerateFn } from './agent-helper.js'
import { assertSafeIdent } from '../helpers.js'
import { SchemaError, ConfigError } from '../errors.js'

/** 构建分拆提示：要求只输出一个 JSON 数组，每项 {name, goal, agent?}。 */
export function buildDecomposePrompt(goal, { agentsList = [], priorError } = {}) {
  const agentsLine = agentsList.length ? agentsList.join(', ') : '(无预置 agent，留空 agent 字段即可)'
  // goal 用代码块包裹：防止 goal 里含 Markdown 标题（如 "# Output format"）
  // 破坏 prompt 的分节结构，让 LLM 误读约束条件。
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
\`\`\`text
${goal}
\`\`\`

Output ONLY the JSON array.`
  if (priorError) {
    // 用代码块包围错误，防止 LLM 输出携带的内容注入新 prompt。
    p += `\n\n# Your previous attempt was REJECTED:\n\`\`\`text\n${priorError}\n\`\`\`\nFix it and output ONLY the corrected JSON array.`
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
  if (!match) throw new SchemaError('未找到 JSON 任务数组', '未找到 JSON 任务数组')
  let raw
  try { raw = JSON.parse(match[0]) } catch (e) { throw new SchemaError(`JSON 解析失败：${e.message}`, e.message) }
  if (!Array.isArray(raw) || raw.length === 0) throw new SchemaError('任务清单为空', '任务清单为空')

  const usedNames = new Set()
  return raw.map((t, i) => {
    if (!t || typeof t !== 'object') throw new SchemaError(`任务 ${i} 不是对象`, `任务 ${i} 不是对象`)
    const goal = String(t.goal ?? '').trim()
    if (!goal) throw new SchemaError(`任务 ${i}（${t.name ?? '?'}）缺少 goal`, `任务 ${i} 缺少 goal`)

    // name 规整为 kebab-case 安全标识；去重时不断加序号后缀直到不冲突。
    // 原来用 Map 记计数，但无法检测「生成的 foo-2 与字面量 foo-2 同名」的碰撞，
    // 改用 Set 记录所有已使用名字，每次找到第一个可用后缀。
    let base = String(t.name ?? `task-${i + 1}`).trim().toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `task-${i + 1}`
    let name = base
    if (usedNames.has(name)) {
      let n = 2
      while (usedNames.has(`${base}-${n}`)) n++
      name = `${base}-${n}`
    }
    usedNames.add(name)

    // assertSafeIdent 校验：name 会被拼入文件路径（worktree 目录 + run 目录），
    // 必须符合白名单字符要求（字母数字开头结尾，中间允许 . _ -）。
    // 若 LLM 输出的 name 不合法（如含空格、斜线、中文），上面的 replace 链应已规整，
    // 但仍做兜底校验：不合法则抛错触发 decompose 回喂重试。
    try {
      assertSafeIdent(name, 'task.name')
    } catch (e) {
      e.message = `任务 ${i} 的 name '${name}': ${e.message}`
      throw e
    }

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
  throw new ConfigError(`decompose 失败（${maxAttempts} 次尝试）：${lastErr}`)
}
