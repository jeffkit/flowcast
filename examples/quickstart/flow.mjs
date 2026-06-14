#!/usr/bin/env node
/**
 * flowcast 最小可跑 flow 模板。
 *
 * - dry-run（npm run dry）：零配置即可跑通骨架（执行器被 fake，不烧 API）。
 * - 真跑（npm run start）：需要 ~/.flowcast/agents.json 里有 --agent 指定的 profile。
 *
 * 只 import flowcast（+ util），只用 FLOW_API 词汇表的原语——
 * 这与 L3 生成的 flow 同构，可被 dry-run 校验。
 */
import { parseArgs } from 'util'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  notify, setHitlBackend,
} from 'flowcast'

const { values: opts } = parseArgs({ options: {
  'run-id':       { type: 'string' },
  repo:           { type: 'string', default: process.cwd() },
  goal:           { type: 'string', default: '在 README 末尾追加一行 "hello from flowcast"' },
  agent:          { type: 'string', default: 'cursor-default' },
  'dry-run':      { type: 'boolean', default: false },
  hitl:           { type: 'string', default: 'terminal' },
  'project-name': { type: 'string', default: 'flowcast-quickstart' },
} })

if (opts['dry-run']) process.env.FLOWCAST_DRY_RUN = '1'

const runId = opts['run-id'] ?? `quickstart-${Date.now()}`
const repo = opts.repo

setWorkdir(repo)
setHitlBackend(opts.hitl === 'wecom' ? 'wecom' : 'terminal', { projectName: opts['project-name'] })

const cp = new Checkpoint(runId)
const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

await main()

async function main() {
  // step 1：让 agent 做个简短计划（dry-run 下返回假结果）
  const plan = await cp.step('plan', () =>
    runProfile(opts.agent, `为这个目标列 1-3 步极简计划：${opts.goal}`))

  // step 2：执行
  const result = await cp.step('apply', () =>
    runProfile(opts.agent, `按这个计划执行目标「${opts.goal}」：\n${String(plan)}`))

  cp.done({ goal: opts.goal })
  await notify('quickstart flow 完成')
  console.log('\n✓ done. 产物见 .flowcast/runs/' + runId + '/report.md')
  console.log(String(result).slice(0, 400))
}

// 按 agent profile 名跑一次执行器（dry-run 自动 fake）
async function runProfile(agentName, goal, extra = {}) {
  const a = resolveAgent(agentName, agents, { providers })
  return a.run(goal, { cwd: repo, ...a.opts, ...extra })
}
