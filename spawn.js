// spawn.js — 底层子进程原语
//
// 统一 spawnCapture（捕获式，不因非零退出 reject）与 spawnCli（失败抛错）两种调用形态。
// 之前 spawnCli 与 spawnCapture 各自实现了 ~80% 相同的超时/kill 逻辑——改为 spawnCli
// 直接调用 spawnCapture，单一事实来源，bug 修一处即可。
//
// 同时收归 sweepStaleTmp（flowcast 临时文件清理），此前放在 subflow.js 是职责越界。

import { spawn, execFileSync } from 'child_process'
import { readdirSync, statSync, unlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isRetryable, TimeoutError, SpawnError } from './errors.js'

// ── 共享常量 ─────────────────────────────────────────────────────────

/** 子进程 stdout/stderr 缓冲区上限（16 MB）。超出时截断并追加标记，防 verbose 子进程 OOM 宿主。
 *  导出供 subflow.js 复用，保持单一事实来源——两处缓冲区逻辑对齐同一阈值。 */
export const SPAWN_MAX_BUF = 16 * 1024 * 1024

// ── provider 回退判定 ────────────────────────────────────────────────
//
// 委托到 errors.js 的统一 isRetryable，保留本名兼容现有调用方。

export function isProviderRetryable(err) {
  return isRetryable(err)
}

// ── spawnCapture：捕获式 spawn ───────────────────────────────────────
//
// 不因非零退出码 reject，合并 stdout+stderr，带 16 MB 缓冲区守卫。
// 返回 { stdout, exitCode, timedOut, spawnError? }。
//
// 挂起防护（2026-08-03，recursive gate 卡死复盘）：
//   - 超时按整棵进程树 kill（见 killTree）——只 kill 直接子进程时，孙进程
//     （sh -c → cargo-mutants → cargo test）逃逸后继续持有 stdout/stderr 管道，
//     `close` 永不触发，spawnCapture 的 Promise 永不 settle，调用方 await 卡死。
//   - `close` failsafe：`exit`（子进程退出）后 stdio 仍可能被逃逸孙进程持有
//     （daemon 化 / 后台进程继承管道），`close` 同样不触发。exit 后限时等待
//     close（FLOWCAST_CLOSE_GRACE_MS，默认 3s），超时强制收尾并带截断标记，
//     保证 Promise 必 settle。超时后 exit 的场景由 SIGKILL 之后的 failsafe
//     兜底，避免在 kill 尝试完之前提前 resolve、放走未杀干净的孙进程。

/**
 * @param {string}   cmd
 * @param {string[]} args
 * @param {object}   [opts]
 * @param {string}   [opts.cwd]
 * @param {number}   [opts.timeout]
 * @param {object}   [opts.env]      合并进 process.env 的额外变量
 * @param {Function} [opts.onData]   流式输出回调 (chunk: string) => void
 * @param {string}   [opts.stdin]    写入子进程 stdin 后立即 EOF
 * @returns {Promise<{stdout:string, exitCode:number, timedOut:boolean, spawnError?:string}>}
 */
export function spawnCapture(cmd, args, { cwd = process.cwd(), timeout, env, onData, stdin } = {}) {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ stdout: `[spawn error] ${err.message}`, exitCode: -1, timedOut: false, spawnError: err.message })
      return
    }
    if (stdin != null) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
    let out = ''
    let timedOut = false
    const append = d => {
      const s = d.toString()
      onData?.(s)
      if (out.length < SPAWN_MAX_BUF) out += s
      else if (!out.endsWith('\n[output truncated]')) out += '\n[output truncated]'
    }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)

    // 单一 settle 点：close / error / failsafe 全部收敛到 finish，防重复 resolve。
    // patch 覆盖默认字段（exitCode / spawnError / stdout），调用方字段顺序不变。
    let settled = false
    let forceTimer = null
    let hardKillTimer
    const finish = (patch = {}) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      if (forceTimer) clearTimeout(forceTimer)
      resolve({ stdout: out, exitCode: -1, timedOut, ...patch })
    }
    const closeGraceMs = () => {
      // 惰性读 env（测试用短值加速 failsafe 路径），默认 3s
      const v = parseInt(process.env.FLOWCAST_CLOSE_GRACE_MS ?? '', 10)
      return Number.isFinite(v) && v > 0 ? v : 3_000
    }
    // failsafe 收尾：管道未关（逃逸孙进程持有）→ 已收集输出可能缺尾，标记后强制 resolve
    const forceFinish = (exitCode, reason) => {
      const mark = out.endsWith('\n[output truncated]') ? '' : `\n[output truncated: ${reason}]`
      finish({ stdout: out + mark, exitCode: exitCode ?? -1 })
    }
    let exitCodeRef = null
    proc.on('exit', code => {
      exitCodeRef = code ?? exitCodeRef
      if (timedOut) return // 超时后 exit 由 SIGKILL 之后的 failsafe 兜底
      forceTimer = setTimeout(() => forceFinish(exitCodeRef, 'stdio held open after exit'), closeGraceMs())
    })

    // 超时：SIGTERM 整棵进程树给 5 秒清场 → SIGKILL 兜底 → 仍未 close 则强制收尾。
    // 注意不是 proc.kill 单杀——直接子进程被杀后孙进程逃逸持管道，close 永不触发
    // （见本节头部注释）。
    const timer = timeout ? setTimeout(() => {
      timedOut = true
      killTree(proc.pid, 'SIGTERM')
      hardKillTimer = setTimeout(() => {
        killTree(proc.pid, 'SIGKILL')
        // SIGKILL 后管道仍未关（setsid 逃逸等 killTree 够不着的极端场景）→ 兜底
        // resolve。此时 SIGTERM/SIGKILL 均已尝试完，不存在提前放走孙进程的问题。
        forceTimer = setTimeout(() => forceFinish(exitCodeRef, 'stdio held open after kill'), closeGraceMs())
      }, 5_000)
    }, timeout) : null

    proc.on('error', err => {
      finish({ spawnError: err.message, stdout: out + `\n[spawn error] ${err.message}` })
    })
    proc.on('close', code => {
      finish({ exitCode: code ?? exitCodeRef ?? -1 })
    })
  })
}

// ── killTree：整棵进程树 kill ────────────────────────────────────────
//
// 超时 kill 只打直接子进程时，孙进程（sh -c → cargo-mutants → cargo test）会
// 逃逸并继续持有 stdout/stderr 管道——`close` 永不触发（见 spawnCapture 头部注释）。
//
// 竞态防护：先把根 SIGSTOP 冻结，再 ps 快照。被 STOP 的进程无法再 fork，
// 「快照之后、kill 之前」新出生的子进程逃逸窗口直接不存在（实测复现：sh 被
// CPU 饿死到 timeout 附近才调度，正好在快照与 kill 之间 fork 出 sleep → 逃逸）。
// SIGTERM 对 STOP 态进程是 pending 的，需再发 SIGCONT 才生效；SIGKILL 无此问题。
// 不用 detached/进程组方案：detached 会把子进程挪出终端的进程组/session，
// Ctrl+C 等终端信号不再传到子进程，破坏交互式使用。

const KILLTREE_PS_MAXBUF = 16 * 1024 * 1024 // 与 SPAWN_MAX_BUF 对齐

function killTree(rootPid, signal) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return
  // 冻结根：阻止其（及其后代）在快照与 kill 之间 fork 新子进程
  try { process.kill(rootPid, 'SIGSTOP') } catch { /* 已死，照常快照 */ }
  // ps 失败重试 3 次（EAGAIN / maxBuffer 溢出等瞬时故障）；全失败则退化为只杀
  // 直接子进程，逃逸后代由 close failsafe 保证 Promise 必 settle。
  let order = null
  for (let attempt = 0; attempt < 3; attempt++) {
    let rows
    try {
      rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: KILLTREE_PS_MAXBUF })
    } catch {
      continue
    }
    const children = new Map() // ppid -> [pid...]
    for (const line of rows.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)/)
      if (!m) continue
      const [pid, ppid] = [parseInt(m[1], 10), parseInt(m[2], 10)]
      if (pid === ppid || ppid <= 0) continue
      if (!children.has(ppid)) children.set(ppid, [])
      children.get(ppid).push(pid)
    }
    order = [rootPid] // BFS：根在前，叶子在后
    for (let i = 0; i < order.length; i++) {
      order.push(...(children.get(order[i]) ?? []))
    }
    break
  }
  if (!order) {
    try { process.kill(rootPid, signal) } catch { /* 已死或权限不足 */ }
    return
  }
  for (const pid of order.reverse()) { // 叶子先杀（根最后），防中间层先死收不到信号
    try { process.kill(pid, signal) } catch { /* 已死或权限不足，跳过 */ }
    if (signal === 'SIGTERM') { // STOP 态下 TERM 是 pending，CONT 唤醒后生效
      try { process.kill(pid, 'SIGCONT') } catch { /* ignore */ }
    }
  }
}

// ── spawnCli：期望成功的子进程调用 ─────────────────────────────────
//
// 原先 spawnCli 与 spawnCapture 是两套独立实现（~80% 重复）。
// 现在 spawnCli 只是 spawnCapture 上的薄包装：非零退出 / 超时 / spawn 失败时 throw。
// 所有超时/kill/缓冲区逻辑只有 spawnCapture 一份。

/**
 * 期望成功的子进程调用——非零退出 / 超时 / spawn 失败时抛错。
 *
 * 支持两种调用约定（向后兼容）：
 *   - 旧式位置参数：`spawnCli(cli, args, cwd, timeout, env)`
 *   - 新式 options 对象：`spawnCli(cli, args, { cwd, timeout, env, onData, stdin })`
 *
 * 新代码应使用 options 对象签名，与 spawnCapture 保持一致，避免漏传 env。
 *
 * @param {string}   cli
 * @param {string[]} args
 * @param {string | {cwd?:string, timeout?:number, env?:object, onData?:Function, stdin?:string}} [cwdOrOpts]
 * @param {number}   [timeout]  仅位置参数模式有效
 * @param {object}   [env]      仅位置参数模式有效
 * @returns {Promise<string>} stdout
 */
export async function spawnCli(cli, args, cwdOrOpts, timeout, env) {
  let opts
  if (cwdOrOpts !== null && typeof cwdOrOpts === 'object') {
    opts = cwdOrOpts
  } else {
    opts = { cwd: cwdOrOpts, timeout, env }
  }
  const r = await spawnCapture(cli, args, opts)
  if (r.spawnError) {
    throw new SpawnError(`[${cli}] spawn failed: ${r.spawnError}`, r.spawnError)
  }
  if (r.timedOut) {
    throw new TimeoutError(`[${cli}] timeout after ${timeout}ms`)
  }
  if (r.exitCode !== 0) {
    throw new SpawnError(`[${cli}] exit ${r.exitCode}\n${r.stdout.trim()}`, null, { exitCode: r.exitCode, output: r.stdout })
  }
  return r.stdout
}

// ── sweepStaleTmp：stale 临时文件清理 ───────────────────────────────
//
// SIGKILL 兜底：codex adapter 的 /tmp/flowcast-codex-*.txt 与
// failure-context 的 .consuming.* sidecar 在 finally 之前被 kill 时留盘。
// flowcast 启动时（bin/flowcast.js）调一次，静默清理，失败不影响主流程。
// 从 subflow.js 迁来——临时文件清理属于进程管理职责，与子流调度无关。

// 1h 没动 → 视为 stale；可通过 FLOWCAST_STALE_TMP_MS 环境变量覆盖（测试场景用小值加速清理）
const _envStaleTmpMs = parseInt(process.env.FLOWCAST_STALE_TMP_MS ?? '', 10)
const STALE_TMP_MS = Number.isFinite(_envStaleTmpMs) && _envStaleTmpMs > 0 ? _envStaleTmpMs : 60 * 60 * 1000
const STALE_TMP_PREFIXES = [
  'flowcast-codex-',
  'flowx-codex-',       // legacy
  'flowcast-check-',    // orchestrator/validate.js 语法校验临时目录
  'flowcast-dryrun-',   // orchestrator/validate.js dry-run 校验临时 git repo
]

/**
 * 扫描 tmpdir 清理 stale 的 flowcast-* 临时文件。
 * @param {object} [opts]
 * @param {number} [opts.olderThanMs]
 * @param {string} [opts.baseDir]
 * @returns {string[]} 已删除的文件名列表
 */
export function sweepStaleTmp({ olderThanMs = STALE_TMP_MS, baseDir = tmpdir() } = {}) {
  const removed = []
  try {
    const now = Date.now()
    for (const name of readdirSync(baseDir)) {
      const isOurs = STALE_TMP_PREFIXES.some(p => name.startsWith(p))
        || /-failure-context\.md\.consuming\..*\.owner\..*/.test(name)
      if (!isOurs) continue
      try {
        const full = join(baseDir, name)
        const st = statSync(full)
        if (now - st.mtimeMs > olderThanMs) {
          if (st.isDirectory()) {
            rmSync(full, { recursive: true, force: true })
          } else {
            unlinkSync(full)
          }
          removed.push(name)
        }
      } catch { /* 单条目失败跳过 */ }
    }
  } catch { /* 扫不动就放弃 */ }
  return removed
}
