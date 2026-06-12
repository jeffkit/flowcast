#!/usr/bin/env node
/**
 * flowx CLI 入口
 *
 * 用法：
 *   flowx force-dev --feature add-search-pagination --repo .
 *   flowx force-dev --run-id run-xxx          # 断点续跑
 *   flowx list                                 # 列出所有 run
 *   flowx run <flow-file.js> [args...]         # 跑自定义 flow
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const [,, command, ...rest] = process.argv

if (!command || command === '--help' || command === '-h') {
  console.log(`
flowx — lightweight workflow runner

Commands:
  force-dev          Run the force-dev flow (feature branch → code → review → PR)
  orchestrate <goal> L3: generate a flow from a goal, validate it, then run it
  list               List all workflow runs in current project
  run <file>         Run a custom flow file

Examples:
  flowx force-dev --feature add-login --repo .
  flowx force-dev --run-id run-1234567890      # resume a paused run
  flowx orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet
  flowx orchestrate "..." --run-id orch-123    # resume: reuse generated flow.mjs
  flowx orchestrate "..." --dry-run            # generate for real, execute with fakes
  flowx orchestrate "大目标" --split --concurrency 3   # decompose → flow per task → fan out
  flowx list
  flowx run ./flows/my-flow.js --foo bar
`)
  process.exit(0)
}

if (command === 'list') {
  // 列出当前项目的所有 run
  process.argv = [process.argv[0], process.argv[1], '--list']
  await import(join(__dirname, '../flows/force-dev.js'))

} else if (command === 'force-dev') {
  // 把剩余参数透传给 force-dev flow
  process.argv = [process.argv[0], process.argv[1], ...rest]
  await import(join(__dirname, '../flows/force-dev.js'))

} else if (command === 'orchestrate') {
  // L3：一行需求 → 生成 flow → 校验 → 执行（续跑锁定）
  const { runOrchestrate } = await import(join(__dirname, '../orchestrator/cli.js'))
  process.exit(await runOrchestrate(rest))

} else if (command === 'run') {
  // 跑任意自定义 flow 文件
  const flowFile = rest[0]
  if (!flowFile) {
    console.error('用法: flowx run <flow-file.js>')
    process.exit(1)
  }
  process.argv = [process.argv[0], process.argv[1], ...rest.slice(1)]
  await import(resolve(process.cwd(), flowFile))

} else {
  console.error(`未知命令: ${command}。运行 flowx --help 查看帮助。`)
  process.exit(1)
}
