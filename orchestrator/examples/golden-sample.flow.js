#!/usr/bin/env node
/**
 * 黄金样例：并行多 agent 分析 → 质量门 → 综合收口。
 *
 * 既当 codegen few-shot，又当 validateFlow 的 dry-run 验证靶子。
 * 100% 遵循 orchestrator/FLOW_API.md：只 import flowcast，只用契约原语，编排全在 main()。
 */
import { parseArgs } from 'util'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runGate,
  parallel,
  notify, setHitlBackend,
  flowcastDir,
} from 'flowcast'

const { values: opts } = parseArgs({ options: {
  'run-id':       { type: 'string' },
  repo:           { type: 'string', default: process.cwd() },
  goal:           { type: 'string' },
  agent:          { type: 'string' },
  gate:           { type: 'string' },
  'dry-run':      { type: 'boolean', default: false },
  hitl:           { type: 'string', default: 'terminal' },
  'project-name': { type: 'string', default: 'flowcast' },
} })

if (opts['dry-run']) process.env.FLOWCAST_DRY_RUN = '1'

const runId = opts['run-id'] ?? `analyze-${Date.now()}`
const repo = opts.repo
const goal = opts.goal ?? 'src'

setWorkdir(repo)
setHitlBackend(opts.hitl === 'wecom' ? 'wecom' : 'terminal', { projectName: opts['project-name'] })

const cp = new Checkpoint(runId, flowcastDir(repo) + '/runs')
const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

await main()

async function main() {
  const targets = goal.split(',').map(s => s.trim()).filter(Boolean)
  const agent = opts.agent ?? 'cursor-default'

  // 并行：每个 target 派给一个 agent 分析
  const findings = await cp.step('analyze', () => parallel(
    targets.map(t => () => runProfile(agent, `Analyze ${t} and report issues.`)),
  ))

  // 质量门：跑一个检查（dry-run 下自动判过）
  await cp.step('gate.lint', () => runGate({ name: 'lint', cmd: opts.gate ?? 'true', cwd: repo, onFail: 'rollback' }))

  // 收口：综合所有发现
  const summary = await cp.step('synthesize', () =>
    runProfile(agent, `Synthesize these findings into one report:\n${findings.map(String).join('\n---\n')}`))

  cp.done({ targets: targets.length })
  await notify(`analysis done for ${targets.length} target(s)`)
  console.log(String(summary))
}

async function runProfile(agentName, taskGoal, extra = {}) {
  const a = resolveAgent(agentName, agents, { providers })
  return a.run(taskGoal, { cwd: repo, ...a.opts, ...extra })
}
