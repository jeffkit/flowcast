#!/usr/bin/env node
/**
 * goal-drive.js — 用 loop 原语「反复跑 agent 直到目标达成」的活样例
 *
 * 用法：
 *   node flows/goal-drive.js --goal "<目标>" --gate "npm test" --repo . --cli claude
 *   node flows/goal-drive.js --prompt-file ./goal.md --gate "npm test" --max-turns 8
 *   node flows/goal-drive.js --run-id <id>            # 断点续跑（同 run）
 *   node flows/goal-drive.js --dry-run                # 假执行器 + 假质量门，空跑骨架
 *
 * 流程（对应 Ralph Loop / cursor-goal 的 goal-driven 模式）：
 *   loop 每轮 →
 *     1. fresh 调一次 agent（注入 goal + 跨-run 记忆 + 上轮结论）
 *     2. 跑验证门（--gate 命令），软判定：红灯不中止，作为「还没达成」喂回下一轮
 *     3. 红灯把失败输出沉淀进跨-run memory，下一轮 fresh context 仍能读到
 *   门全绿即 isDone=true → completed；达不到目标则 maxTurns 触顶 → budget_exhausted。
 *
 * 设计：loop / memory / quality-gate / runAgent 都是 flowx 一等原语，本 flow 只做薄编排。
 *      「反复跑到达成、且越跑越聪明」是通用能力 → 放原语；具体目标/验证命令是业务 → 留脚本。
 */

import { parseArgs } from 'util'
import { readFileSync } from 'fs'
import { join } from 'path'
import { loop } from '../loop.js'
import { runAgent, setWorkdir } from '../agent.js'
import { runGate } from '../quality-gate.js'
import { recordLearning } from '../memory.js'

const { values: opts } = parseArgs({
  options: {
    'run-id':      { type: 'string' },
    goal:          { type: 'string' },
    'prompt-file': { type: 'string' },
    gate:          { type: 'string' },              // 验证命令（达成判定），如 "npm test"
    repo:          { type: 'string', default: process.cwd() },
    cli:           { type: 'string', default: 'claude' },
    'max-turns':   { type: 'string', default: '10' },
    'memory-scope':{ type: 'string' },              // 不传则不启用跨-run 记忆
    'dry-run':     { type: 'boolean', default: false },
  },
})

if (opts['dry-run']) process.env.FLOWX_DRY_RUN = '1'

const repo = opts.repo
const runId = opts['run-id'] ?? `goal-${Date.now()}`
const maxTurns = Math.max(1, parseInt(opts['max-turns'], 10) || 10)
const memoryScope = opts['memory-scope'] ?? null

const goal = opts['prompt-file']
  ? readFileSync(opts['prompt-file'], 'utf8')
  : opts.goal
if (!goal) {
  console.error('缺少 --goal 或 --prompt-file')
  process.exit(1)
}
if (!opts.gate) {
  console.error('缺少 --gate（验证命令，用作目标达成判定，如 "npm test"）')
  process.exit(1)
}

setWorkdir(repo)
console.log(`\n▶ goal-drive  run=${runId}  repo=${repo}  cli=${opts.cli}  maxTurns=${maxTurns}\n`)

const result = await loop(
  async ({ turn, goal, memorySection, lastVerdict }) => {
    const prompt = [
      goal,
      memorySection || '',
      lastVerdict === 'continue' ? '\n上一轮验证未通过，请修复后继续。' : '',
    ].filter(Boolean).join('\n\n')
    const out = await runAgent(prompt, { cli: opts.cli, cwd: repo })
    return String(out)
  },
  {
    goal,
    runId,
    stateDir: join(repo, '.flowx/runs'),
    maxTurns,
    memoryScope,
    // 每轮硬验证用软判定：把 --gate 的成败转成 isDone 信号（红灯=未达成、再来一轮）。
    isDone: async ({ turn }) => {
      const passed = await gatePassed(opts.gate, repo)
      if (!passed && memoryScope) {
        recordLearning(memoryScope, {
          topic: `turn ${turn}: gate '${opts.gate}' failed`,
          rootCause: 'verification command exited non-zero',
          fix: null,
          tags: ['loop', 'gate-fail'],
          runId,
        })
      }
      console.log(`  turn ${turn}: gate ${passed ? '✓ 通过（目标达成）' : '✗ 未通过，继续'}`)
      return passed
    },
    onEvent: (e) => { if (e.phase === 'budget') console.warn(`  [budget] ${e.reason} 触顶于 turn ${e.turn}`) },
  },
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`✓ goal-drive ${result.status}  turns=${result.turns}  run=${result.runId}`)
if (result.status === 'budget_exhausted') {
  console.log('  目标在预算内未达成；调大 --max-turns 或人工介入后用同 --run-id 续跑。')
  process.exit(2)
}

// ── 验证门软判定：try/catch 包 runGate（rollback 抛错）转成布尔，红灯不中止主流程 ──
async function gatePassed(cmd, cwd) {
  try {
    await runGate({ name: 'goal-check', cmd, cwd, onFail: 'rollback' })
    return true
  } catch {
    return false
  }
}
