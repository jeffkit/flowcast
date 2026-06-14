// dashboard/cli.js — `flowcast dashboard` 的参数解析与执行。
import { parseArgs } from 'util'
import { spawn } from 'child_process'
import { resolve } from 'path'
import { generateDashboard } from './index.js'

/**
 * @param {string[]} argv  bin/flowcast.js 透传的剩余参数
 * @returns {Promise<number>} 退出码
 */
export async function runDashboard(argv) {
  let opts
  try {
    ({ values: opts } = parseArgs({
      args: argv,
      options: {
        repo:        { type: 'string', default: process.cwd() },
        out:         { type: 'string' },
        open:        { type: 'boolean', default: false },
        'stale-min': { type: 'string' },   // 僵尸阈值（分钟），默认 10
      },
    }))
  } catch (e) {
    console.error(`参数错误: ${e.message}`)
    console.error('用法: flowcast dashboard [--repo .] [--out path.html] [--open] [--stale-min 10]')
    return 1
  }

  const repo = resolve(opts.repo)
  const staleMs = opts['stale-min'] ? Math.max(0, parseFloat(opts['stale-min'])) * 60_000 : undefined

  const { out, model } = generateDashboard({ repo, out: opts.out, staleMs })
  const s = model.stats
  console.log(`\n📊 flowcast dashboard 已生成：${out}`)
  console.log(`   ${s.total} runs · 运行中 ${s.running} · 僵尸 ${s.stale} · 暂停 ${s.paused} · 完成 ${s.completed}`)
  if (s.fallback || s.gateFail) console.log(`   信号：fallback ${s.fallback} · 质量门红灯 ${s.gateFail}`)

  if (opts.open) openInBrowser(out)
  else console.log(`   浏览器打开：file://${out}`)

  return 0
}

/** 跨平台打开文件（best-effort，失败只告警不报错）。 */
function openInBrowser(path) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (e) {
    console.warn(`   (自动打开失败，请手动打开 file://${path}): ${e.message}`)
  }
}
