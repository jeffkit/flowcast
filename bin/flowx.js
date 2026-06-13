#!/usr/bin/env node
/**
 * flowcast CLI 入口（命令别名：flowcast / flowc / fc / flowx）
 *
 * 用法：
 *   flowcast run <name-or-file> [args...]  # 按名字查 ~/.flowx/flows/ 或直接跑文件
 *   flowcast flows list                    # 列出已安装的用户级 flow
 *   flowcast flows install <src>           # 安装 flow 到 ~/.flowx/flows/
 *   flowcast flows remove <name>           # 移除用户级 flow
 *   flowcast list                          # 列出当前项目的所有 run
 *   flowcast orchestrate <goal>            # L3 orchestrator
 *   flowcast dashboard                     # 可观测看板
 *
 * flow 文件可直接 `import { Checkpoint, fanOut } from 'flowcast'`，
 * 全局安装后无需在业务项目里建 package.json / node_modules。
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join, resolve, basename } from 'path'
import { existsSync, readdirSync, copyFileSync, mkdirSync, unlinkSync } from 'fs'
import { homedir } from 'os'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const [,, command, ...rest] = process.argv

// 用户级 flows 目录：优先 ~/.flowcast/flows，向后兼容 ~/.flowx/flows
const _home = homedir()
const USER_FLOWS_DIR = existsSync(join(_home, '.flowcast'))
  ? join(_home, '.flowcast', 'flows')
  : join(_home, '.flowx', 'flows')

/**
 * 解析 flow 名或文件路径 → 绝对路径。
 * 优先级：本地路径 > 项目级 .flowx/flows/ > 用户级 ~/.flowx/flows/
 */
function resolveFlowFile(nameOrPath, cwd = process.cwd()) {
  if (nameOrPath.startsWith('/') || nameOrPath.startsWith('./') || nameOrPath.startsWith('../')) {
    return resolve(cwd, nameOrPath)
  }
  const name = nameOrPath.endsWith('.js') ? nameOrPath : `${nameOrPath}.js`
  // 项目级：优先 .flowcast/flows，向后兼容 .flowx/flows
  const projectFlowCast = join(cwd, '.flowcast', 'flows', name)
  const projectFlowX = join(cwd, '.flowx', 'flows', name)
  const projectFlow = existsSync(projectFlowCast) ? projectFlowCast : projectFlowX
  if (existsSync(projectFlow)) return projectFlow
  const userFlow = join(USER_FLOWS_DIR, name)
  if (existsSync(userFlow)) return userFlow
  return null
}

function spawnFlow(flowAbs, args) {
  const { spawnSync } = require('child_process')
  const pkgIndex     = resolve(__dirname, '../index.js')
  const resolverHook = resolve(__dirname, 'flowx-resolver.mjs')
  const result = spawnSync(
    'node',
    ['--import', resolverHook, flowAbs, ...args],
    { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, FLOWCAST_PKG_INDEX: pkgIndex } }
  )
  return result.status ?? 1
}

if (!command || command === '--help' || command === '-h') {
  console.log(`
flowcast — lightweight workflow runner  (aliases: flowcast / flowc / fc / flowx)

Commands:
  run <name|file>      Run a named user flow or a local flow file
  flows list           List installed user-level flows (~/.flowx/flows/)
  flows install <src>  Install a flow file to ~/.flowx/flows/
  flows remove <name>  Remove a user-level flow
  orchestrate <goal>   L3: generate a flow from a goal, validate it, then run it
  dashboard            Generate a static observability dashboard (HTML) for all runs
  list                 List all workflow runs in current project (needs force-dev flow installed)

Examples:
  flowcast flows install /path/to/force-lab/flows/force-dev.js
  flowcast run force-dev --feature add-login --repo .
  flowcast run force-dev --run-id run-1234567890      # resume a paused run
  flowcast run ./my-custom-flow.js --repo .
  flowcast orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet
  flowcast orchestrate "..." --run-id orch-123
  flowcast orchestrate "大目标" --split --concurrency 3
  flowcast dashboard --repo . --open
  flowcast list
`)
  process.exit(0)
}

if (command === 'flows') {
  const sub = rest[0]

  if (!sub || sub === 'list') {
    if (!existsSync(USER_FLOWS_DIR)) {
      console.log('~/.flowx/flows/ 为空，尚未安装任何 flow。')
      console.log('安装示例：flowx flows install ./flows/force-dev.js')
    } else {
      const files = readdirSync(USER_FLOWS_DIR).filter(f => f.endsWith('.js'))
      if (files.length === 0) {
        console.log('~/.flowx/flows/ 为空，尚未安装任何 flow。')
      } else {
        console.log('已安装的用户级 flow（~/.flowx/flows/）：')
        files.forEach(f => console.log(`  ${f.replace(/\.js$/, '')}`))
      }
    }

  } else if (sub === 'install') {
    const src = rest[1]
    if (!src) { console.error('用法: flowx flows install <flow-file.js>'); process.exit(1) }
    const srcAbs = resolve(process.cwd(), src)
    if (!existsSync(srcAbs)) { console.error(`文件不存在: ${srcAbs}`); process.exit(1) }
    mkdirSync(USER_FLOWS_DIR, { recursive: true })
    const dest = join(USER_FLOWS_DIR, basename(srcAbs))
    copyFileSync(srcAbs, dest)
    console.log(`✓ 已安装: ${basename(srcAbs)} → ${dest}`)

  } else if (sub === 'remove') {
    const name = rest[1]
    if (!name) { console.error('用法: flowx flows remove <name>'); process.exit(1) }
    const target = join(USER_FLOWS_DIR, name.endsWith('.js') ? name : `${name}.js`)
    if (!existsSync(target)) { console.error(`未找到: ${target}`); process.exit(1) }
    unlinkSync(target)
    console.log(`✓ 已移除: ${target}`)

  } else {
    console.error(`未知子命令: flows ${sub}。可用：list / install / remove`)
    process.exit(1)
  }

} else if (command === 'list') {
  // 便捷别名：列出当前项目的所有 run（依赖 force-dev flow）
  const flowAbs = resolveFlowFile('force-dev')
  if (!flowAbs) {
    console.error('需要先安装 force-dev flow：flowx flows install <path-to-force-dev.js>')
    process.exit(1)
  }
  process.exit(spawnFlow(flowAbs, ['--list']))

} else if (command === 'orchestrate') {
  // L3：一行需求 → 生成 flow → 校验 → 执行（续跑锁定）
  const { runOrchestrate } = await import(join(__dirname, '../orchestrator/cli.js'))
  process.exit(await runOrchestrate(rest))

} else if (command === 'dashboard') {
  // 可观测看板：扫描 .flowx/runs + worktree → 生成单文件 HTML（只读快照）
  const { runDashboard } = await import(join(__dirname, '../dashboard/cli.js'))
  process.exit(await runDashboard(rest))

} else if (command === 'run') {
  const nameOrFile = rest[0]
  if (!nameOrFile) {
    console.error('用法: flowx run <name|flow-file.js> [args...]')
    console.error('已安装的 flow：flowx flows list')
    process.exit(1)
  }

  const flowAbs = resolveFlowFile(nameOrFile)
  if (!flowAbs) {
    console.error(`未找到 flow: ${nameOrFile}`)
    console.error(`查找路径：`)
    console.error(`  项目级: ${join(process.cwd(), '.flowcast', 'flows', nameOrFile + '.js')} 或 .flowx/flows/`)
    console.error(`  用户级: ${join(USER_FLOWS_DIR, nameOrFile + '.js')}`)
    console.error(`安装：flowx flows install <path-to-flow.js>`)
    process.exit(1)
  }

  process.exit(spawnFlow(flowAbs, rest.slice(1)))

} else {
  console.error(`未知命令: ${command}。运行 flowx --help 查看帮助。`)
  process.exit(1)
}
