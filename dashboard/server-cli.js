// dashboard/server-cli.js — `flowcast dashboard-server` 的参数解析与启动。
//
// 与 dashboard/cli.js（静态 HTML 看板）对应：本命令启动一个常驻 HTTP 服务，
// 提供全局项目聚合入口（登记多个项目 + 每个项目的 run 历史）。
// 参数风格与 dashboard/cli.js 完全一致（util.parseArgs + try/catch → usage → return 1）。
import { parseArgs } from 'util'
import { spawn } from 'child_process'
import { startServer } from './server.js'
import { listRecent } from './projects.js'

/**
 * @param {string[]} argv  bin/flowcast.js 透传的剩余参数
 * @returns {Promise<number>} 退出码
 */
export async function runDashboardServer(argv) {
  let opts
  try {
    ({ values: opts } = parseArgs({
      args: argv,
      options: {
        port:        { type: 'string', default: '4173' },
        host:        { type: 'string', default: '127.0.0.1' },
        open:        { type: 'boolean', default: false },
        'stale-min': { type: 'string' },   // 僵尸阈值（分钟），默认 10
      },
    }))
  } catch (e) {
    console.error(`参数错误: ${e.message}`)
    console.error('用法: flowcast dashboard-server [--port 4173] [--host 127.0.0.1] [--open] [--stale-min 10]')
    return 1
  }

  const port = parseInt(opts.port, 10)
  const host = opts.host
  const staleMs = opts['stale-min'] ? Math.max(0, parseFloat(opts['stale-min'])) * 60_000 : undefined

  const server = await startServer({ port, host, staleMs })
  const addr = server.address()
  const url = `http://${host}:${typeof addr === 'object' && addr ? addr.port : port}`

  const projects = listRecent()
  console.log(`\n📊 flowcast dashboard-server 已启动`)
  console.log(`   地址：${url}`)
  console.log(`   已登记项目：${projects.length} 个`)
  if (projects.length === 0) {
    console.log(`   提示：在页面里点「添加项目」登记一个 flowcast 项目目录即可。`)
  } else {
    for (const p of projects.slice(0, 5)) console.log(`     · ${p.name}  (${p.path})`)
    if (projects.length > 5) console.log(`     · ...还有 ${projects.length - 5} 个`)
  }
  console.log(`   按 Ctrl+C 停止。\n`)

  if (opts.open) openInBrowser(url)

  // 优雅关闭：SIGINT/SIGTERM → close server → 进程退出。
  // 不 process.exit，让 server 自然 drain；返回的是「不退出」——由调用方 process.exit。
  const shutdown = (sig) => {
    console.log(`\n收到 ${sig}，关闭中...`)
    server.close(() => process.exit(0))
    // 兜底：1s 后强制退（连接卡住时）
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // 保持进程不退出（server.listen 已是异步引用，但显式返回未 settle 的 promise 更清晰）。
  // 进程实际由 signal handler 终结。
  await new Promise(() => {})
  return 0
}

/** 跨平台打开 URL（best-effort，失败只告警不报错）。与 dashboard/cli.js 同实现。 */
function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (e) {
    console.warn(`   (自动打开失败，请手动访问 ${url}): ${e.message}`)
  }
}
