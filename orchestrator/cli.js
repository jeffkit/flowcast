// orchestrator/cli.js — `flowx orchestrate` 命令：把 L3 端到端编排接到命令行。
//
// 一行需求 → 受控生成 flow → 跑前校验 → 子进程隔离执行（续跑锁定）。
// 这是 L3 codegen harness 的命令行入口：把库里的 orchestrate() 接通成可 dogfood 的命令。
//
// dry-run 语义：生成阶段仍走「真实 agent」产出 flow 代码（无法凭空伪造合法代码），
// 但生成的 flow 子进程以 FLOWX_DRY_RUN 运行——执行器/质量门被 fake，不烧 API、不跑构建。
// 纯结构冒烟（不触碰真实 LLM）见 test 里注入 generate 的用法。

import { parseArgs } from 'util'
import { loadAgents } from '../executor.js'
import { loadProviders } from '../provider.js'
import { orchestrate, orchestrateMulti } from './run.js'

/**
 * 处理 `flowx orchestrate` 命令。
 * @param {string[]} argv  命令名之后的原始参数（不含 node/script）
 * @param {object} [o]
 * @param {Function} [o.generate]  可注入的生成函数（测试用，省去真实 LLM）
 * @param {Function} [o.onData]    子进程输出回调（默认透传 stdout）
 * @returns {Promise<number>} 进程退出码（0 成功）
 */
export async function runOrchestrate(argv, { generate, onData = (d) => process.stdout.write(d) } = {}) {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      goal:           { type: 'string' },
      repo:           { type: 'string', default: process.cwd() },
      'run-id':       { type: 'string' },
      agent:          { type: 'string' },
      'dry-run':      { type: 'boolean', default: false },
      timeout:        { type: 'string' },
      hitl:           { type: 'string', default: 'terminal' },
      'project-name': { type: 'string', default: 'flowx' },
      // 接单分拆模式：先把大目标拆成多个子任务，各自生成 flow，再并发执行
      split:          { type: 'boolean', default: false },
      concurrency:    { type: 'string' },
      inplace:        { type: 'boolean', default: false },  // 分拆模式下不做 worktree 隔离
    },
  })

  // goal 可来自位置参数或 --goal
  const goal = (opts.goal ?? positionals.join(' ')).trim()
  if (!goal) {
    console.error('用法: flowx orchestrate "<目标描述>" [--repo .] [--agent <name>] [--run-id <id>] [--dry-run]')
    return 1
  }

  const repo = opts.repo
  const timeout = opts.timeout ? parseInt(opts.timeout, 10) : undefined
  const dryRun = opts['dry-run']

  const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

  // ── 接单分拆模式：大目标 → 拆子任务 → 各自生成 flow → fanOut 并发执行 ──
  if (opts.split) {
    const runId = opts['run-id'] ?? `orchm-${Date.now()}`
    const concurrency = opts.concurrency ? Math.max(1, parseInt(opts.concurrency, 10) || 1) : 2
    console.log(`\n▶ orchestrate --split  run=${runId}  repo=${repo}  并发=${concurrency}${dryRun ? '  [dry-run]' : ''}`)
    console.log(`  goal: ${goal}`)
    const r = await orchestrateMulti(goal, {
      repo, runId, agent: opts.agent, agents, providers,
      concurrency, isolate: opts.inplace ? 'none' : 'worktree', dryRun, timeout, onData,
    })
    if (!r.ok && r.stage === 'decompose') {
      console.error(`\n✗ 分拆失败：${r.error}`)
      return 1
    }
    if (!r.ok && r.stage === 'generate') {
      console.error(`\n✗ 子任务 '${r.task}' 生成/校验失败：${r.error}`)
      return 1
    }
    const okN = r.results.filter(x => x.result.ok).length
    console.log(`\n${r.ok ? '✓' : '✗'} orchestrate --split ${r.ok ? '完成' : '部分失败'}  ${okN}/${r.tasks} 子任务成功`)
    for (const x of r.results) console.log(`  ${x.result.ok ? '✓' : '✗'} ${x.task.name}  exit=${x.result.exitCode}`)
    return r.ok ? 0 : 1
  }

  // ── 单 flow 模式 ──
  const runId = opts['run-id'] ?? `orch-${Date.now()}`
  // HITL 设置透传给生成的 flow 子进程（骨架已支持 --hitl / --project-name）
  const extraArgs = ['--hitl', opts.hitl, '--project-name', opts['project-name']]

  console.log(`\n▶ orchestrate  run=${runId}  repo=${repo}${dryRun ? '  [dry-run]' : ''}`)
  console.log(`  goal: ${goal}`)
  if (opts.agent) console.log(`  agent: ${opts.agent}`)

  const r = await orchestrate(goal, {
    repo, runId, agent: opts.agent, agents, providers, generate,
    dryRun, timeout, onData, extraArgs,
  })

  if (!r.ok && r.stage === 'generate') {
    console.error(`\n✗ 生成/校验失败（attempts=${r.attempts}）：${r.error}`)
    console.error(`  生成产物见：${r.file}`)
    return 1
  }
  if (r.reused) console.log('  (复用已存在 flow.mjs，续跑锁定，未重新生成)')
  console.log(`\n${r.ok ? '✓' : '✗'} orchestrate ${r.ok ? '完成' : '失败'}  exit=${r.exitCode}`)
  console.log(`  flow: ${r.file}`)
  return r.ok ? 0 : 1
}
