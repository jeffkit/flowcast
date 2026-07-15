// executor/recursive-extras.js — recursive CLI 的 flowcast 专属 _meta 增强
//
// agentproc v0.10.0 的 recursive executor 只负责「把 recursive 的 AgentEvent NDJSON 翻成
// agentproc 自己的 NDJSON 事件」——但 flowcast 历史 _meta 字段里需要的额外信号（finishReason /
// budgetExceeded / panicked / transcriptMessages）它不解析。
//
// 本模块负责在 agentproc 返回的 RunResult 上做一次 post-processing：
//   - 解析 `[done after N steps] reason: <X>` 标记 → _meta.finishReason
//   - exit code ≥ 128 或 101 → _meta.panicked = true
//   - transcriptOut 指定的 transcript.jsonl 文件 → _meta.transcriptMessages
//   - throwOnCritical=true 时把 panic / BudgetExceeded / 非零退出转成 FlowcastError('RECURSIVE_FAIL')
//
// 注意：本模块仅处理「成功路径」的 RunResult；error 路径仍由 agentproc-adapter 的
// resultToAgentResult 转成 FlowcastError / TimeoutError / SpawnError。

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { FlowcastError } from '../errors.js'

/**
 * 解析 recursive 二进制路径：优先 release，其次 debug，最后 PATH 上的 recursive。
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
export function resolveRecursiveBin(cwd = process.cwd()) {
  for (const p of ['target/release/recursive', 'target/debug/recursive']) {
    if (existsSync(join(cwd, p))) return join(cwd, p)
  }
  return 'recursive'
}

const BUDGET_EXCEEDED_RE = /reason:\s*BudgetExceeded/
const FINISH_REASON_RE = /\[done after \d+ steps\]\s*reason:\s*(.+)/
const PANIC_RE = /panicked at|thread 'main' panicked/i

/**
 * 从 RunResult.reply（recursive 完整 stdout）解析 finishReason / budgetExceeded / panicked。
 * 若 opts.transcriptOut 存在且可读，附加 transcriptMessages 计数。
 *
 * @param {object} runResult   agentproc RunResult（成功路径，error 为空）
 * @param {object} [opts]      flowcast opts（用于找 transcriptOut）
 * @returns {object}           要合并进 _meta 的字段
 */
export function deriveRecursiveMeta(runResult, opts = {}) {
  // 兼容 agentproc RunResult（.reply）和 spawnCapture（.stdout）两种形态
  const stdout = runResult.reply ?? runResult.stdout ?? ''
  const finishMatch = stdout.match(FINISH_REASON_RE)
  const finishReason = finishMatch ? finishMatch[1].trim() : null
  const budgetExceeded = BUDGET_EXCEEDED_RE.test(stdout)
  const exitCode = runResult.exitCode ?? 0
  const panicked = exitCode === 101 || (typeof exitCode === 'number' && exitCode >= 128)

  const meta = {
    finishReason,
    budgetExceeded,
    panicked,
    transcriptMessages: countTranscriptMessages(opts.transcriptOut),
  }
  return meta
}

function countTranscriptMessages(transcriptOut) {
  if (!transcriptOut || !existsSync(transcriptOut)) return 0
  try {
    const data = JSON.parse(readFileSync(transcriptOut, 'utf8'))
    return data?.messages?.length ?? 0
  } catch {
    return 0  // transcript 可能未写完（被 timeout 截断等）
  }
}

/**
 * 若 throwOnCritical 且 RunResult 表示失败（panic / budgetExceeded / 非零退出），
 * 抛 FlowcastError('RECURSIVE_FAIL')。否则返回原 RunResult + 增强 _meta。
 *
 * @param {object} runResult
 * @param {object} [opts]
 * @returns {object} 增强 _meta（fields: finishReason / budgetExceeded / panicked / transcriptMessages）
 * @throws  FlowcastError('RECURSIVE_FAIL') 当 throwOnCritical 且失败
 */
export function maybeThrowRecursiveCritical(runResult, opts = {}) {
  const stdout = runResult.reply ?? runResult.stdout ?? ''
  const exitCode = runResult.exitCode ?? 0
  const budgetExceeded = BUDGET_EXCEEDED_RE.test(stdout)
  const panicked = exitCode === 101 || (typeof exitCode === 'number' && exitCode >= 128)
  const failed = panicked || budgetExceeded || exitCode !== 0

  if (opts.throwOnCritical === true && failed) {
    const reason = panicked ? 'panicked' : budgetExceeded ? 'BudgetExceeded' : `exit ${exitCode}`
    throw new FlowcastError(
      `[recursive] failed: ${reason}\n${stdout.slice(0, 500)}`,
      'RECURSIVE_FAIL',
      {
        _meta: {
          cli: 'recursive',
          exitCode,
          timedOut: !!runResult.timedOut,
          panicked,
          budgetExceeded,
          finishReason: (stdout.match(FINISH_REASON_RE)?.[1] ?? '').trim() || null,
          transcriptMessages: countTranscriptMessages(opts.transcriptOut),
        },
      },
    )
  }
  return deriveRecursiveMeta(runResult, opts)
}