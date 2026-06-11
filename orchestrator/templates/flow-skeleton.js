#!/usr/bin/env node
/**
 * <FLOW_TITLE>
 *
 * 由 flowx L3 codegen harness 生成（或手写）。遵循 orchestrator/FLOW_API.md 契约：
 * 只 import @force-lab/flowx，只用契约列出的原语，编排逻辑全部写在 main() 的占位处。
 */
import { parseArgs } from 'util'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runGate, runGates,
  withSelfModGuard, captureBaseline,
  parallel,
  waitForInput, notify, setHitlBackend,
  writeFailureContext,
  isDryRun,
} from '@force-lab/flowx'

const { values: opts } = parseArgs({ options: {
  'run-id':       { type: 'string' },
  repo:           { type: 'string', default: process.cwd() },
  goal:           { type: 'string' },
  agent:          { type: 'string' },
  gate:           { type: 'string' },
  'dry-run':      { type: 'boolean', default: false },
  hitl:           { type: 'string', default: 'terminal' },
  'project-name': { type: 'string', default: 'flowx' },
} })

if (opts['dry-run']) process.env.FLOWX_DRY_RUN = '1'

const runId = opts['run-id'] ?? `flow-${Date.now()}`
const repo = opts.repo
const goal = opts.goal ?? ''

setWorkdir(repo)
setHitlBackend(opts.hitl === 'wecom' ? 'wecom' : 'terminal', { projectName: opts['project-name'] })

const cp = new Checkpoint(runId)
const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

await main()

async function main() {
  // <<ORCHESTRATION>>  ← LLM 只填这里
}

/** 按 agent profile 名跑一次执行器；dry-run 下自动 fake。 */
async function runProfile(agentName, taskGoal, extra = {}) {
  const a = resolveAgent(agentName, agents, { providers })
  return a.run(taskGoal, { cwd: repo, ...a.opts, ...extra })
}
