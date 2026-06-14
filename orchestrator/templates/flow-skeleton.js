#!/usr/bin/env node
/**
 * <FLOW_TITLE>
 *
 * 由 flowcast L3 codegen harness 生成（或手写）。遵循 orchestrator/FLOW_API.md 契约：
 * 只 import flowcast，只用契约列出的原语，编排逻辑全部写在 main() 的占位处。
 */
import { parseArgs } from 'util'
import {
  Checkpoint, PauseSignal, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runGate, runGates,
  withSelfModGuard, captureBaseline,
  parallel,
  waitForInput, notify, setHitlBackend,
  writeFailureContext,
  isDryRun,
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
  'project-name': { type: 'string', default: 'flowx' },
} })

if (opts['dry-run']) process.env.FLOWCAST_DRY_RUN = '1'

const runId = opts['run-id'] ?? `flow-${Date.now()}`
const repo = opts.repo
const goal = opts.goal ?? ''

setWorkdir(repo)
setHitlBackend(opts.hitl === 'wecom' ? 'wecom' : 'terminal', { projectName: opts['project-name'] })

const cp = new Checkpoint(runId, flowcastDir(repo) + '/runs')
const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

// PauseSignal 是 HITL pause() 抛出的信号：状态已落盘，进程应干净退出等待续跑。
try {
  await main()
} catch (e) {
  if (e instanceof PauseSignal) process.exit(0)
  throw e
}

async function main() {
  // <<ORCHESTRATION>>  ← LLM 只填这里
}

/** 按 agent profile 名跑一次执行器；dry-run 下自动 fake。 */
async function runProfile(agentName, taskGoal, extra = {}) {
  const a = resolveAgent(agentName, agents, { providers })
  return a.run(taskGoal, { cwd: repo, ...a.opts, ...extra })
}
