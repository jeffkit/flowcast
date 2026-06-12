#!/usr/bin/env node
/**
 * todo-drain.js — 批量消化 TODO.md 的外层 orchestrator
 *
 * 用法：
 *   node flows/todo-drain.js --todo <path/to/TODO.md> --repo <path/to/repo>
 *   node flows/todo-drain.js --run-id <id>           # 断点续跑
 *   node flows/todo-drain.js --list                  # 列出所有 run
 *   node flows/todo-drain.js --dry-run               # 只显示分组，不执行
 *
 * 流程：
 *   1. parse-todos  → 读 TODO.md，解析 open 条目，输出分组 JSON（项目特定逻辑）
 *   2. fanOut       → 每组并发跑一条 force-dev 子 flow（通用原语：限并发 + worktree 隔离 + per-task 日志）
 *   3. 每组完成后，更新 TODO.md 把该组条目标记为 done
 *
 * 设计：TODO.md 的解析/分组/回写是业务特定逻辑，留在本脚本；
 *      「拆成多组 → 并发跑子 flow → 隔离 → 汇总」是通用编排，复用 flowx 的 fanOut 原语。
 *      L3 接单分拆只需把 parseTodos/groupTodos 换成「LLM 生成任务清单」，同样喂给 fanOut。
 */

import { parseArgs } from 'util'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Checkpoint } from '../checkpoint.js'
import { fanOut } from '../subflow.js'
import { parseTodos, groupTodos, groupToFeaturePrompt } from './todo-parser.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── CLI 参数解析 ───────────────────────────────────────────────────
const { values: opts } = parseArgs({
  options: {
    'run-id':  { type: 'string' },
    todo:      { type: 'string' },
    repo:      { type: 'string', default: process.cwd() },
    list:      { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    // 传给 force-dev 的选项
    model:     { type: 'string' },
    reviewer:  { type: 'string', default: 'claude' },
    // 跳过某些组（逗号分隔的 group name）
    skip:      { type: 'string', default: '' },
    // 只跑指定优先级（P1/P2/P3，逗号分隔）
    priority:  { type: 'string', default: '' },
    // 默认每组在独立 git worktree 隔离执行；--inplace 退回主 repo 原地执行
    inplace:   { type: 'boolean', default: false },
    // 并发度：>1 时多组同时各跑一条 force-dev（输出分流到各自日志文件）
    concurrency: { type: 'string', default: '1' },
  }
})

const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 1)

if (opts.list) { listRuns(); process.exit(0) }

const runId = opts['run-id'] ?? `drain-${Date.now()}`
const repo  = opts.repo
const skipNames = opts.skip ? opts.skip.split(',').map(s => s.trim()) : []
const filterPriority = opts.priority ? opts.priority.split(',').map(s => s.trim()) : []

// ── 主流程 ────────────────────────────────────────────────────────
const cp = new Checkpoint(runId, join(repo, '.flowx/runs'))

// 续跑时从 state 恢复参数
const todoPath = opts.todo ?? cp.getPauseContext().todoPath
if (!todoPath) {
  console.error('缺少 --todo 参数（指向 TODO.md 的路径）')
  process.exit(1)
}

console.log(`\n▶ todo-drain  run=${runId}  repo=${repo}  todo=${todoPath}`)
if (opts['dry-run']) console.log('  [dry-run 模式，只显示分组]\n')

await run()

// ── 阶段实现 ──────────────────────────────────────────────────────

async function run() {
  // Step 1：解析 TODO.md → 分组（项目特定逻辑）
  const groups = await cp.step('parse-todos', async () => {
    const content = readFileSync(todoPath, 'utf8')
    const items = parseTodos(content)
    let groups = groupTodos(items)

    if (filterPriority.length > 0) {
      groups = groups.filter(g => filterPriority.includes(g.priority))
    }

    console.log(`\n  解析到 ${items.length} 条 open 条目，分为 ${groups.length} 组`)
    groups.forEach((g, i) => {
      const skip = skipNames.includes(g.name) ? ' [SKIP]' : ''
      console.log(`    ${i + 1}. [${g.priority}] ${g.name} (${g.items.length} 条)${skip}`)
    })

    return groups
  })

  if (opts['dry-run']) {
    console.log('\n[dry-run] 分组如上，退出。')
    console.log('\n运行命令示例：')
    console.log(`  node flows/todo-drain.js --todo ${todoPath} --repo ${repo} --run-id ${runId}`)
    process.exit(0)
  }

  // Step 2：挑出待跑的组（排除 skip 列表 + checkpoint 已完成），构建 fanOut 任务
  let skipped = 0
  let alreadyDone = 0
  const forceDevPath = join(__dirname, 'force-dev.js')
  const tasks = []

  for (const group of groups) {
    const stepKey = `group.${group.name}`
    if (skipNames.includes(group.name)) {
      console.log(`  [skip] ${group.name}（用户指定跳过）`)
      skipped++
      continue
    }
    if (cp.has(stepKey)) {
      console.log(`  [skip] ${stepKey}（已完成）`)
      alreadyDone++
      continue
    }

    // prompt 文件始终放主 repo 的 .flowx（用绝对路径传给 force-dev，worktree 内也能读）
    const featureName = `todo-${group.name}`
    const featurePromptFile = join(repo, '.flowx', `prompt-${group.name}.md`)
    mkdirSync(dirname(featurePromptFile), { recursive: true })
    writeFileSync(featurePromptFile, groupToFeaturePrompt(group))

    const args = ['--feature', featureName, '--reviewer', opts.reviewer, '--prompt-file', featurePromptFile]
    if (opts.model) args.push('--model', opts.model)

    tasks.push({
      name: featureName,
      flow: forceDevPath,
      runId: `${runId}-${group.name}`,
      args,
      _group: group,
      _stepKey: stepKey,
    })
  }

  // Step 3：fanOut 并发调度（worktree 隔离 + 限并发 + per-task 日志由原语提供）
  let completed = 0
  let failed = 0

  if (tasks.length > 0) {
    const live = concurrency === 1  // 串行时实时透传输出；并发时分流到日志文件避免交错
    const logDir = join(repo, '.flowx/runs', runId)
    console.log(`\n  待跑 ${tasks.length} 组，并发度 ${concurrency}${live ? '' : `（实时输出见 ${logDir}/<组>.log）`}`)

    await fanOut(tasks, {
      repo,
      concurrency,
      isolate: opts.inplace ? 'none' : 'worktree',
      timeout: 7_200_000,  // 2 小时上限
      logDir: live ? undefined : logDir,
      onData: live ? (d) => process.stdout.write(d) : undefined,
      // 隔离后把项目级 .flowx/config.json 拷进 worktree（untracked，不随 worktree 带入），
      // 保证 force-dev 在 worktree 里能读到 qualityGates/extraArgs/timeout。
      prepare: (_task, { worktree }) => {
        if (!worktree) return
        const srcCfg = join(repo, '.flowx', 'config.json')
        if (existsSync(srcCfg)) {
          mkdirSync(join(worktree, '.flowx'), { recursive: true })
          copyFileSync(srcCfg, join(worktree, '.flowx', 'config.json'))
        }
      },
      // 并发安全地回写 checkpoint + 成功则更新 TODO.md（cp.record / markTodosAsDone 均为同步，不交错）
      onResult: ({ task, result, worktree }) => {
        const success = result.ok
        const reason = success ? 'ok' : (result.spawnError ? 'spawn error' : `exit ${result.exitCode}`)
        cp.record(task._stepKey, { success, reason, featureName: task.name, forceDevRunId: task.runId, worktree })
        if (success) {
          completed++
          markTodosAsDone(todoPath, task._group.items.map(it => it.id))
          console.log(`  ✓ ${task.name}（${reason}）`)
        } else {
          failed++
          console.warn(`  ✗ ${task.name} 未完成（${reason}），继续其他组`)
        }
      },
    })
  }

  // Step 4：最终报告
  await cp.step('final-report', async () => {
    const total = groups.length - skipped
    const summary = `${completed + alreadyDone}/${total} 组完成，${failed} 组失败，${skipped} 组跳过`
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`✓ todo-drain 完成  ${summary}`)
    return summary
  })

  cp.done({ completed: completed + alreadyDone, failed, skipped, total: groups.length })
}

// ── 更新 TODO.md：标记已完成条目 ─────────────────────────────────

function markTodosAsDone(todoPath, ids) {
  if (!existsSync(todoPath)) return
  let content = readFileSync(todoPath, 'utf8')

  for (const id of ids) {
    // 把 "- **状态**：open" 替换为 done，精确到该 ID 下的块
    // 用双重定位：先找 "### ID" 块，再在块内替换状态行
    const blockPattern = new RegExp(
      `(###\\s+${escapeRegex(id)}\\s*[·•\\-][\\s\\S]*?)(- \\*\\*状态\\*\\*：)open`,
      'g'
    )
    content = content.replace(blockPattern, '$1$2done')
  }

  writeFileSync(todoPath, content)
  console.log(`  ✓ TODO.md 已更新：${ids.join(', ')} → done`)
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 列出所有 run ──────────────────────────────────────────────────
function listRuns() {
  const dir = join(repo, '.flowx/runs')
  if (!existsSync(dir)) { console.log('无历史 run'); return }
  readdirSync(dir)
    .filter(id => id.startsWith('drain-'))
    .forEach(id => {
      try {
        const s = JSON.parse(readFileSync(join(dir, id, 'state.json'), 'utf8'))
        console.log(`${id}  status=${s.status}  step=${s.currentStep ?? s.status}`)
      } catch { /* 损坏的 state，跳过 */ }
    })
}
