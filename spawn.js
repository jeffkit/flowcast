// spawn.js — 底层子进程原语
//
// 统一 spawnCapture（捕获式，不因非零退出 reject）与 spawnCli（失败抛错）两种调用形态。
// 之前 spawnCli 与 spawnCapture 各自实现了 ~80% 相同的超时/kill 逻辑——改为 spawnCli
// 直接调用 spawnCapture，单一事实来源，bug 修一处即可。
//
// 同时收归 sweepStaleTmp（flowcast 临时文件清理），此前放在 subflow.js 是职责越界。

import { spawn } from 'child_process'
import { readdirSync, statSync, unlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isRetryable, TimeoutError, SpawnError } from './errors.js'

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
    // 缓冲区上限 16 MB：超出时截断并追加标记，防 verbose 子进程 OOM 宿主
    const MAX_BUF = 16 * 1024 * 1024
    const append = d => {
      const s = d.toString()
      onData?.(s)
      if (out.length < MAX_BUF) out += s
      else if (!out.endsWith('\n[output truncated]')) out += '\n[output truncated]'
    }
    proc.stdout.on('data', append)
    proc.stderr.on('data', append)
    // 超时：先 SIGTERM 给 5 秒清场，再 SIGKILL 兜底
    let hardKillTimer
    const timer = timeout ? setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      hardKillTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* ignore */ }
      }, 5_000)
    }, timeout) : null
    proc.on('error', err => {
      if (timer) clearTimeout(timer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      resolve({ stdout: out + `\n[spawn error] ${err.message}`, exitCode: -1, timedOut, spawnError: err.message })
    })
    proc.on('close', code => {
      if (timer) clearTimeout(timer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      resolve({ stdout: out, exitCode: code ?? -1, timedOut })
    })
  })
}

// ── spawnCli：期望成功的子进程调用 ─────────────────────────────────
//
// 原先 spawnCli 与 spawnCapture 是两套独立实现（~80% 重复）。
// 现在 spawnCli 只是 spawnCapture 上的薄包装：非零退出 / 超时 / spawn 失败时 throw。
// 所有超时/kill/缓冲区逻辑只有 spawnCapture 一份。

/**
 * @param {string}   cli
 * @param {string[]} args
 * @param {string}   cwd
 * @param {number}   timeout
 * @param {object}   [env]  额外环境变量
 * @returns {Promise<string>} stdout
 */
export async function spawnCli(cli, args, cwd, timeout, env) {
  const r = await spawnCapture(cli, args, { cwd, timeout, env })
  if (r.spawnError) {
    throw new SpawnError(`[${cli}] spawn failed: ${r.spawnError}`, r.spawnError)
  }
  if (r.timedOut) {
    throw new TimeoutError(`[${cli}] timeout after ${timeout}ms`)
  }
  if (r.exitCode !== 0) throw new Error(`[${cli}] exit ${r.exitCode}\n${r.stdout.trim()}`)
  return r.stdout
}

// ── sweepStaleTmp：stale 临时文件清理 ───────────────────────────────
//
// SIGKILL 兜底：codex adapter 的 /tmp/flowcast-codex-*.txt 与
// failure-context 的 .consuming.* sidecar 在 finally 之前被 kill 时留盘。
// flowcast 启动时（bin/flowcast.js）调一次，静默清理，失败不影响主流程。
// 从 subflow.js 迁来——临时文件清理属于进程管理职责，与子流调度无关。

const STALE_TMP_MS = 60 * 60 * 1000  // 1h 没动 → 视为 stale
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
