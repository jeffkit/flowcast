// bin/supervisor.js — `flowcast run --supervise`：监督一个 flow 跑通。
//
// 与 orchestrate 对偶：
//   orchestrate = 一段编排需求 → 生成 flow → 跑一次（flow 锁定不变）
//   run --supervise = 跑一个已有 flow → 挂了就让 agent 修 flow → 用同一 runId 续跑 → 直到跑通
//
// 续跑语义：flow 内部用 Checkpoint，失败的 step 不写 completed，续跑时重跑；
// 成功的 step 被跳过。所以 supervisor 修完 flow 用同一 runId 续跑，自然"从失败处继续"。
//
// 修复范围：只改 flow 文件本身（修 flow 代码的 bug、调整编排逻辑），不动业务代码。
// 跑前用 validateFlow 校验改后的 flow（语法/import 白名单/dry-run）。

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { runFlow } from '../subflow.js'
import { validateFlow } from '../orchestrator/validate.js'
import { resolveAgent } from '../executor.js'
import { flowcastDir } from '../dirs.js'
import { ConfigError } from '../errors.js'

/**
 * 从 agent 输出里抽取 flow 代码：优先 ```js/mjs 代码块，否则整段。
 * （与 orchestrator/generate.js 的 extractCode 同思路，这里独立一份避免跨层依赖。）
 */
export function extractFlowCode(text) {
  const fence = String(text).match(/```(?:js|javascript|mjs)?\s*\n([\s\S]*?)```/)
  return (fence ? fence[1] : String(text)).trim()
}

/**
 * 首轮修复 prompt：把规则 + 当前 flow 代码 + 失败详情都给 agent（建立完整上下文）。
 * 用代码块包围，防止其中的内容被当成 prompt 指令（注入防护）。
 */
export function buildFixPrompt(failureDetail, flowCode) {
  return `你是 flowcast flow 修复专家。下面的 flow 在运行时失败了，请诊断原因并修复 flow 代码。

# 修复规则（必须遵守）
- 只修改 flow 代码本身（编排逻辑、step 的 prompt、错误处理），不要输出业务代码。
- 修复后输出完整的 flow 文件（不是 diff），放在一个 \`\`\`js 代码块里。
- flow 必须仍只 import \`flowcast\`（+ \`util\`），只用 flowcast 原语。
- 优先修导致失败的那个 step；不要改动已成功的 step 的逻辑（它们会被续跑跳过）。

# 当前 flow 代码
\`\`\`js
${flowCode}
\`\`\`

# 运行失败详情
\`\`\`text
${failureDetail}
\`\`\`

请输出修复后的完整 flow 代码（单个 \`\`\`js 代码块，不要解释）。`
}

/**
 * 后续轮修复 prompt：只抛新的失败问题。
 * 依赖 agentproc session 续接——agent 在同一 session 里记得前面的对话和自己的修改，
 * 所以不需要重复贴 flow 代码或汇总历史，只告诉它"又出现了这个错误"即可。
 */
export function buildFollowupPrompt(failureDetail) {
  return `改完后再跑，又失败了。这是新的错误：

\`\`\`text
${failureDetail}
\`\`\`

请基于我们之前的讨论继续诊断，输出修复后的完整 flow 代码（单个 \`\`\`js 代码块）。`
}

/**
 * 读 flow 上次运行的失败 step 详情（从 state.json 的 steps[] 里找 error）。
 * 拿不到就返回空串（supervisor 会回落到只用 stderr）。
 */
function readFailureStep(repo, runId) {
  const statePath = join(flowcastDir(repo), 'runs', runId, 'state.json')
  if (!existsSync(statePath)) return ''
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const errStep = (state.steps ?? []).find(s => s.status === 'error')
    if (!errStep) return ''
    return `失败 step: ${errStep.key}\n错误: ${JSON.stringify(errStep.error ?? {})}`
  } catch {
    return ''  // state.json 损坏或不存在，回落
  }
}

/**
 * 运行监督模式：跑 flow，挂了就修，续跑，直到跑通或达到 maxTurns。
 *
 * @param {object} o
 *   - flowAbs       flow 文件绝对路径
 *   - repo          目标仓
 *   - runId         续跑用的 run id（同一 flow 多轮续跑用同一个）
 *   - agent         修复用的 agent profile 名（缺省 'default'）
 *   - agents        已加载的 agents map
 *   - providers     已加载的 providers map
 *   - maxTurns      最多迭代轮数（默认 5）
 *   - dryRun        透传给 runFlow
 *   - onData        runFlow 的实时输出回调
 *   - injected       测试注入：{ runFlow, validateFlow, runFixAgent } 各可单独覆盖
 *   - out            输出流（默认 process.stdout）
 * @returns {Promise<number>} 退出码（0=跑通，1=超 maxTurns 仍失败）
 */
export async function runSupervised({
  flowAbs, repo, runId, agent = 'default', agents = {}, providers = {},
  maxTurns = 5, dryRun = false, onData,
  injected = {}, out = process.stdout,
} = {}) {
  if (!existsSync(flowAbs)) {
    out.write(`✗ flow 文件不存在: ${flowAbs}\n`)
    return 1
  }

  const doRunFlow = injected.runFlow ?? ((...args) => runFlow(...args))
  const doValidate = injected.validateFlow ?? ((...args) => validateFlow(...args))
  // doFixAgent：接收 { prompt, sessionId }，返回 { output, sessionId }。
  // sessionId 续接是关键——同一 session 里 agent 记得前面的诊断和自己的修改，
  // 后续轮只需抛新问题，不用重复贴 flow 代码或汇总历史。
  const doFixAgent = injected.runFixAgent ?? (async ({ prompt, sessionId }) => {
    const effective = agent && agents[agent] ? agent : (agents.default ? 'default' : null)
    if (!effective) {
      throw new ConfigError(
        `supervise 需要一个 agent 来修 flow，但未找到 agent '${agent}'，且无 default 配置。` +
        `请用 --agent <name> 指定，或在 ~/.flowcast/agents.json 配置 default。`,
      )
    }
    const a = resolveAgent(effective, agents, { providers })
    const result = await a.run(prompt, { cwd: repo, sessionId: sessionId || undefined, ...a.opts })
    return { output: String(result), sessionId: result?._meta?.sessionId ?? sessionId }
  })

  out.write(`\n▶ supervise  flow=${flowAbs}  run=${runId}  agent=${agent}  maxTurns=${maxTurns}\n`)

  let sessionId = null  // 跨轮续接的 agentproc session id

  for (let turn = 1; turn <= maxTurns; turn++) {
    out.write(`\n── 轮次 ${turn}/${maxTurns} ──\n`)
    const result = await doRunFlow(flowAbs, { repo, runId, agent, dryRun, onData, cwd: repo })

    if (result.ok) {
      out.write(`\n✓ 第 ${turn} 轮跑通（flow 已完善）\n`)
      return 0
    }

    // 失败：收集详情
    const failureStep = readFailureStep(repo, runId)
    const failureDetail = [
      `exit=${result.exitCode}`,
      result.stderr ? `stderr:\n${result.stderr.slice(-2000)}` : '',  // 截尾，防超长
      failureStep,
    ].filter(Boolean).join('\n\n')
    out.write(`✗ 第 ${turn} 轮失败，准备修 flow…\n`)

    // 修 flow（含 validateFlow 回喂纠错，最多额外 2 次）。
    // 首轮（无 sessionId）用完整 prompt 建立上下文；后续轮用 followup prompt 只抛新问题，
    // 依赖 session 续接让 agent 记得之前的讨论。
    const fixed = await fixWithRetry({
      flowAbs, failureDetail, sessionId, doFixAgent, doValidate, out, maxFixAttempts: 2,
    })
    sessionId = fixed.sessionId  // 记住 session，下一轮续接
    if (!fixed.ok) {
      out.write(`✗ 修复后校验仍不通过：${fixed.error}\n`)
    }
    // 续跑（同一 runId，回到循环顶）
  }

  out.write(`\n✗ 已达 maxTurns=${maxTurns}，flow 仍未跑通。检查 flow 代码或加大 --max-turns。\n`)
  return 1
}

/**
 * 调 agent 修 flow，改完用 validateFlow 校验；不通过则把校验错误回喂再改。
 * 首轮用完整 prompt（带 flow 代码），后续/回喂用 session 续接只抛新问题。
 * @returns {Promise<{ok:boolean, error?:string, sessionId?:string}>}
 */
async function fixWithRetry({ flowAbs, failureDetail, sessionId, doFixAgent, doValidate, out, maxFixAttempts }) {
  let currentSessionId = sessionId
  let isFirst = !sessionId  // 首轮（无 session）要贴完整 flow 代码建立上下文
  let priorError = null
  for (let attempt = 1; attempt <= maxFixAttempts + 1; attempt++) {
    const prompt = isFirst
      ? buildFixPrompt(failureDetail, readFileSync(flowAbs, 'utf8')) +
        (priorError ? `\n\n# 你上次的修复未通过校验，错误：\n\`\`\`text\n${priorError}\n\`\`\`\n请修正后再输出。` : '')
      : buildFollowupPrompt(priorError ? `校验错误：${priorError}` : failureDetail)

    const { output, sessionId: returnedSid } = await doFixAgent({ prompt, sessionId: currentSessionId })
    if (returnedSid) currentSessionId = returnedSid
    isFirst = false  // 后续调用都走 session 续接

    const newCode = extractFlowCode(output)
    if (!newCode) {
      priorError = 'agent 输出里没找到代码块'
      continue
    }
    writeFileSync(flowAbs, newCode, 'utf8')

    const validation = await doValidate(flowAbs)
    if (validation.ok) {
      out.write(`  ✓ flow 已修复（${attempt > 1 ? `第 ${attempt} 次校验通过` : '校验通过'}）\n`)
      return { ok: true, sessionId: currentSessionId }
    }
    priorError = validation.error
    out.write(`  ⚠ 第 ${attempt} 次修复校验未通过：${validation.error}\n`)
  }
  return { ok: false, error: priorError, sessionId: currentSessionId }
}
