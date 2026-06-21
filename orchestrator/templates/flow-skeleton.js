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
  parallel, pipeline,
  runStructured, verifyAdversarial,
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
  'project-name': { type: 'string', default: 'flowcast' },
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

/** 按 agent profile 名跑一次执行器；dry-run 下自动 fake。
 *  传 extra.schema 时强制结构化输出（经 runStructured 校验+回喂重试），返回解析后的对象。
 *  对 recursive 执行器默认启用 throwOnCritical=true：确保 panicked/budgetExceeded/非零退出
 *  正确抛错（而非返回含错误信息的字符串），防止编排层把失败当成功继续执行。
 *  如需保留 recursive 原始「exit code 作数据」语义，显式传 { throwOnCritical: false }。 */
async function runProfile(agentName, taskGoal, extra = {}) {
  const a = resolveAgent(agentName, agents, { providers })
  const { schema, schemaRetries, ...rest } = extra
  // recursive 执行器默认 throwOnCritical=true；调用方可显式覆盖为 false
  const throwOnCritical = a.executor === 'recursive' && !('throwOnCritical' in rest)
    ? true
    : rest.throwOnCritical
  const runOpts = { cwd: repo, ...a.opts, ...rest }
  if (a.executor === 'recursive') runOpts.throwOnCritical = throwOnCritical
  const runner = (p) => a.run(p, runOpts)
  if (schema) return runStructured(runner, taskGoal, { schema, retries: schemaRetries })
  return runner(taskGoal)
}
