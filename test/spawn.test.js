// spawn.test.js — spawnCapture 挂起防护（close failsafe + 超时树级 kill）
//
// 背景（2026-08-03，recursive gate 卡死复盘）：spawnCapture 等 `close`（stdio 全关）
// 而非 `exit`（进程退出）。两类逃逸会让 `close` 永不触发、Promise 永不 settle：
//   1. 超时只 kill 直接子进程 → sh -c 的孙进程（cargo-mutants 等）逃逸，继续持有管道；
//   2. 子进程正常退出，但后台/daemon 化孙进程继承了 stdout 管道。
// 本文件用 sh -c 制造这两类逃逸，验证：超时场景孙进程被整树 kill、两种场景均不挂起。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { spawnCapture } from '../spawn.js'

// pgrep -f 匹配到即认为有残留进程（sh / 本测试进程 cmdline 不含该特征串）
function assertNoResidual(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern])
  assert.notEqual(r.status, 0, `应有残留进程匹配 ${pattern}`)
}

test('超时：树级 kill 杀掉逃逸孙进程，close 正常触发，不挂起', { timeout: 15_000 }, async () => {
  // 每次用唯一时长：若上一次失败漏了孤儿 sleep，pgrep 残留断言不会被污染
  const N = 30 + Math.floor(Math.random() * 270)
  const t0 = Date.now()
  const r = await spawnCapture('sh', ['-c', `sleep ${N} & wait`], { timeout: 800 })
  const elapsed = Date.now() - t0
  assert.equal(r.timedOut, true)
  assert.ok(
    elapsed < 5_000,
    `应 ~800ms+kill 开销即 resolve，实际 ${elapsed}ms（孙进程逃逸，卡到 failsafe 兜底）。stdout=[${r.stdout.slice(0, 200)}]`,
  )
  assertNoResidual(`sleep ${N}`)
})

test('exit 后孙进程持有管道：close failsafe 限时强制收尾，不挂起', { timeout: 15_000 }, async () => {
  process.env.FLOWCAST_CLOSE_GRACE_MS = '500'
  const t0 = Date.now()
  const r = await spawnCapture('sh', ['-c', 'sleep 2 &'])
  const elapsed = Date.now() - t0
  assert.equal(r.timedOut, false)
  assert.equal(r.exitCode, 0)
  assert.ok(
    elapsed >= 400 && elapsed < 5_000,
    `应 ~500ms failsafe 收尾，实际 ${elapsed}ms`,
  )
  assert.ok(r.stdout.includes('stdio held open after exit'), '输出应带 failsafe 截断标记')
})
