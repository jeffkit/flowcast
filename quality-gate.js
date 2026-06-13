import { spawnCapture } from './agent.js'
import { isDryRun } from './dry-run.js'

// ── qualityGate：声明式质量门 ⭐ ───────────────────────────────────
//
// 抽象 self-improve.sh 里反复出现的「跑检查 → 红灯按策略处理」模式：
//   - onFail 'rollback'   红灯直接抛错，交给 withSelfModGuard 硬回滚
//   - onFail 'resume-fix' 红灯把失败输出喂回 agent 修一次，再重测；仍红则抛错
//   - onFail 'autofix'    红灯跑确定性修复命令（如 cargo fmt），不重测不回滚
//
// 对应 cargo test / clippy / fmt / E2E smoke 各自的红灯处理路径。

async function runShell(cmd, cwd, timeout) {
  const command = Array.isArray(cmd) ? cmd.join(' ') : cmd
  return spawnCapture('sh', ['-c', command], { cwd, timeout })
}

/**
 * 执行单个质量门。
 *
 * @param {object} gate
 *   - name        门名（test/clippy/fmt/e2e…）
 *   - cmd         检查命令（string 或 string[]，走 sh -c）
 *   - cwd         工作目录（默认 cwd）
 *   - onFail      'rollback' | 'resume-fix' | 'autofix'（默认 rollback）
 *   - autofixCmd  onFail=autofix 时的修复命令
 *   - resumeFix   onFail=resume-fix 时的修复回调（覆盖 deps.resumeFix）
 *   - timeout     单命令超时 ms
 * @param {object} deps
 *   - resumeFix   async (failureOutput, gate) => boolean（是否已应用修复）
 * @returns {Promise<{name,passed,attempts,output,autofixed?,resumeFixed?}>}
 */
export async function runGate(gate, deps = {}) {
  const { name, cmd, cwd = process.cwd(), onFail = 'rollback', autofixCmd, timeout } = gate
  const resumeFix = gate.resumeFix ?? deps.resumeFix
  // 观测回调：把质量门 pass/fail 写进 jsonl（看板据此标红灯）。gate 级优先于 deps 级。
  const onEvent = gate.onEvent ?? deps.onEvent
  const emit = (data) => { if (onEvent) { try { onEvent({ event: 'gate', name, ...data }) } catch { /* 观测不影响主流程 */ } } }

  // dry-run：不 spawn，直接判过（结构校验用，不烧构建时间）
  if (isDryRun()) return { name, passed: true, attempts: 1, dryRun: true, output: '[dry-run] gate skipped' }

  let { stdout, exitCode } = await runShell(cmd, cwd, timeout)
  if (exitCode === 0) { emit({ status: 'pass', attempts: 1 }); return { name, passed: true, attempts: 1, output: stdout } }

  if (onFail === 'autofix') {
    if (autofixCmd) {
      const fix = await runShell(autofixCmd, cwd, timeout)
      if (fix.exitCode !== 0) {
        emit({ status: 'fail', exitCode: fix.exitCode, autofixFailed: true })
        const err = new Error(`quality gate '${name}': autofixCmd failed (exit ${fix.exitCode})`)
        err.gate = name; err.output = fix.stdout; err.exitCode = fix.exitCode
        throw err
      }
    }
    // autofix 后重跑检查，确认真的修好了
    const re = await runShell(cmd, cwd, timeout)
    if (re.exitCode !== 0) {
      emit({ status: 'fail', exitCode: re.exitCode, autofixFailed: true })
      const err = new Error(`quality gate '${name}': still failing after autofix (exit ${re.exitCode})`)
      err.gate = name; err.output = re.stdout; err.exitCode = re.exitCode
      throw err
    }
    emit({ status: 'pass', attempts: 2, autofixed: true })
    return { name, passed: true, attempts: 2, autofixed: true, output: re.stdout }
  }

  if (onFail === 'resume-fix' && typeof resumeFix === 'function') {
    const applied = await resumeFix(stdout, gate)
    if (applied) {
      const re = await runShell(cmd, cwd, timeout)
      if (re.exitCode === 0) { emit({ status: 'pass', attempts: 2, resumeFixed: true }); return { name, passed: true, attempts: 2, resumeFixed: true, output: re.stdout } }
      stdout = re.stdout
      exitCode = re.exitCode
    }
  }

  emit({ status: 'fail', exitCode })
  const err = new Error(`quality gate '${name}' failed (exit ${exitCode})`)
  err.gate = name
  err.output = stdout
  err.exitCode = exitCode
  throw err
}

/** 顺序跑多个门；任意门红灯（rollback / resume-fix 仍失败）即抛错。 */
export async function runGates(gates, deps = {}) {
  const results = []
  for (const g of gates) results.push(await runGate(g, deps))
  return results
}
