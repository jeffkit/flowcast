import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// ── failure-context：最小 learnings（写入 on-fail + 注入 on-retry）─────
//
// recursive/revengers 都有「把失败教训喂回下一次尝试」的机制。这里只做最小形态：
// 失败时写一份结构化 failure-context.md，下次重试时读取并注入 system prompt，
// 读取后即删除（只注入一次，避免污染后续无关尝试）。完整 RAG 召回留后续。
//
// 跨进程原子性：rename 后还会写一个 PID sidecar（`.<p>.owner.<pid>`）。
// 读侧等 owner 出现后再读正文（最多 50ms），避免读到「rename 已成功但 fsync 还没完成」的中间态。
// 严格跨进程安全请走 flock（本项目零依赖原则下不引）——README/memory 里写明这是 best-effort。

function ctxPath(dir, tag) {
  return join(dir, `${tag}-failure-context.md`)
}

/**
 * 写入失败上下文。
 * @returns {string} 写入的文件路径
 */
export function writeFailureContext(dir, tag, { reason, tailLog = '', provider, model } = {}) {
  mkdirSync(dir, { recursive: true })
  const body = [
    '## Previous Attempt Failed', '',
    `- Reason: ${reason ?? 'unknown'}`,
    provider ? `- Provider: ${provider}` : null,
    model ? `- Model: ${model}` : null,
    `- Timestamp: ${new Date().toISOString()}`, '',
    '### Last lines of agent output:', '```text', tailLog.replace(/```/g, "'''"), '```', '',
    '### Guidance for retry:',
    '- Do NOT repeat the approach that caused this failure.',
    '- If it was a compile/test error, fix it before proceeding.',
    '- If output was truncated, use smaller patches instead of full-file rewrites.',
  ].filter((l) => l !== null).join('\n')
  const p = ctxPath(dir, tag)
  writeFileSync(p, body + '\n')
  return p
}

/**
 * 原子消费失败上下文（只注入一次）。
 * 流程：rename 抢占 + 写 PID sidecar（声明所有权）+ 短暂等 owner 落盘 + 读正文 + 清两个文件。
 *
 * 跨进程行为：先 rename 成功的进程拿到内容；其他进程看到 ENOENT → 返回 null。
 * 调用方拿到 null 时不区分「未写」与「被抢」——这是显式契约（简单优先于完备）。
 *
 * @returns {string|null} 上下文内容，无则 null
 */
export function readAndConsumeFailureContext(dir, tag) {
  const p = ctxPath(dir, tag)
  const tmp = `${p}.consuming.${process.pid}`
  const ownerSidecar = `${tmp}.owner.${process.pid}`
  try {
    renameSync(p, tmp)  // 原子：成功则本进程独占；ENOENT 则文件不存在或已被消费
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  // 写 PID sidecar：声明这是本进程消费的内容（供未来做 owner 校验扩展）。
  // 写失败不影响读——正文已经 rename 到 tmp 是本进程的，sidecar 只是元数据。
  try {
    writeFileSync(ownerSidecar, String(process.pid))
  } catch { /* best-effort sidecar */ }
  // 短暂等待 owner sidecar 落盘：跨进程消费方能据此区分「本进程正在消费」vs「已被抢」。
  // 50ms 内若 fsync 还没完成，正常 fsync 早完成；只是兜底，不是严格保证。
  const deadline = Date.now() + 50
  while (!existsSync(ownerSidecar) && Date.now() < deadline) {
    // busy-wait is acceptable for ≤ 50ms
  }
  try {
    return readFileSync(tmp, 'utf8')
  } finally {
    rmSync(tmp, { force: true })
    rmSync(ownerSidecar, { force: true })
  }
}