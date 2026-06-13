// orchestrator/agent-helper.js — 内部共用：从 agents map 中选定执行器并构建生成函数。
import { resolveAgent } from '../executor.js'

/**
 * 从 agents map 里找出可用 agent，构建 generate(prompt)=>string 函数。
 * generate 注入时直接用，不注入则走 LLM。
 * @param {object} o
 *   - agent        显式指定的 agent 名
 *   - agents       已加载的 agents map
 *   - providers    已加载的 providers map
 *   - repo         cwd
 *   - generate     测试注入，优先于 LLM
 *   - context      调用上下文描述（用于错误消息，如 'orchestrate' / 'orchestrate --split'）
 * @returns {Function} async (prompt) => string
 */
export function resolveGenerateFn({ agent, agents = {}, providers = {}, repo, generate, context = 'orchestrate' }) {
  if (generate) return generate
  const effectiveAgent = agent ?? (agents.default ? 'default' : 'claude-sonnet')
  if (!agent && !agents.default && !agents['claude-sonnet']) {
    const known = Object.keys(agents)
    const hint = known.length
      ? `已定义：${known.join(' / ')}`
      : '请在 ~/.flowcast/agents.json 或 .flowx/agents.json 配置 default agent'
    throw new Error(`${context} 需要一个 agent，但未指定 --agent 且无 default 配置（${hint}）`)
  }
  return async (prompt) => {
    const a = resolveAgent(effectiveAgent, agents, { providers })
    return String(await a.run(prompt, { cwd: repo, ...a.opts }))
  }
}
