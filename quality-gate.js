import { spawnCapture } from './spawn.js'
import { isDryRun } from './dry-run.js'
import { loadMergedConfig, basenamesFor } from './provider.js'
import { parallel } from './concurrency.js'
import { realpathSync, existsSync } from 'fs'
import { resolve } from 'path'
import { GateError, ConfigError } from './errors.js'
import { makeEvent } from './helpers.js'

// ── qualityGate：声明式质量门 ⭐ ───────────────────────────────────
//
// 抽象 self-improve.sh 里反复出现的「跑检查 → 红灯按策略处理」模式：
//   - onFail 'rollback'   红灯直接抛错，交给 withSelfModGuard 硬回滚
//   - onFail 'resume-fix' 红灯把失败输出喂回 agent 修一次，再重测；仍红则抛错
//   - onFail 'autofix'    红灯跑确定性修复命令（如 cargo fmt），不重测不回滚
//
// 对应 cargo test / clippy / fmt / E2E smoke 各自的红灯处理路径。

async function runShell(cmd, cwd, timeout) {
  // 数组形式：直接 spawn，不经 shell——规避「join(' ') 后 sh -c」的命令注入风险
  // （特殊字符不会被 shell 重新解析；但也不做 $VAR / glob 展开）。
  // 字符串形式：走 sh -c，shell 自负责变量展开（FLOW_API 契约允许）。
  if (Array.isArray(cmd)) {
    return spawnCapture(cmd[0], cmd.slice(1), { cwd, timeout })
  }
  return spawnCapture('sh', ['-c', cmd], { cwd, timeout })
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
  // makeEvent 统一事件格式（event + type 双字段）
  const emit = (data) => { if (onEvent) { try { onEvent(makeEvent('gate', { name, ...data })) } catch { /* 观测不影响主流程 */ } } }

  // cwd 安全校验（P1-A5 修复）：
  // 当 deps.repo 已知时，确保 gate 的 cwd 不逃逸 repo 目录（防止 gates.json 被篡改后
  // 用 cwd: '/etc' 让检查命令在任意目录运行）。
  // 只在 cwd 非默认时（gate 显式设置了 cwd）才校验，避免误拦 process.cwd() 默认值。
  //
  // symlink 逃逸修复：对 cwd 和 repo 双侧都做 realpathSync，消除通过符号链接绕过路径前缀
  // 比较的攻击面（如 evil -> /etc 后 cwd='evil' 在 startsWith 检查前看起来合法）。
  // realpathSync 失败（目录不存在等）时拒绝执行，而非保守放行——
  // 无法解析的 cwd 不应允许命令在其中运行。
  if (gate.cwd && deps.repo) {
    try {
      const repoReal = realpathSync(resolve(deps.repo))
      const cwdReal = realpathSync(resolve(cwd))
      if (!cwdReal.startsWith(repoReal + '/') && cwdReal !== repoReal) {
        const err = new ConfigError(
          `quality gate '${name}': cwd '${cwd}' 必须在 repo '${deps.repo}' 内（防路径穿越）`,
        )
        err.gate = name
        throw err
      }
    } catch (e) {
      if (e.configError) throw e
      // realpathSync 失败（路径不存在、权限等）→ 拒绝执行，不保守放行
      // 无法确认安全边界的 cwd 不应允许命令在其中运行。
      const err = new ConfigError(
        `quality gate '${name}': 无法解析 cwd '${cwd}' 或 repo '${deps.repo}' 的真实路径` +
        `（${e.message}）——拒绝执行以防路径穿越`,
      )
      err.gate = name
      throw err
    }
  }

  // 字符串 cmd 安全提示（P1-A5 信息）：
  // 字符串 cmd 走 sh -c，shell 负责变量展开（FLOW_API 契约允许，文档已说明信任边界）。
  // 此处仅对非受信来源的 gates（loadGates 加载的项目级配置）打 debug，不强制拦截。
  // 高安全场景请改用数组形式 cmd（规避 sh -c）。

  // 配置校验：进门前 fail-fast，不白跑检查命令
  if (onFail === 'autofix' && !autofixCmd) {
    const err = new ConfigError(`quality gate '${name}' 配置错误：onFail=autofix 必须同时提供 autofixCmd`)
    err.gate = name
    throw err
  }
  if (onFail === 'resume-fix' && typeof resumeFix !== 'function') {
    const err = new ConfigError(
      `quality gate '${name}' 配置错误：onFail=resume-fix 必须同时提供 resumeFix 回调（函数），` +
      `可通过 gate.resumeFix 或 deps.resumeFix 注入`,
    )
    err.gate = name
    throw err
  }

  // dry-run：不 spawn，直接判过（结构校验用，不烧构建时间）
  if (isDryRun()) return { name, passed: true, attempts: 1, dryRun: true, output: '[dry-run] gate skipped' }

  let { stdout, exitCode } = await runShell(cmd, cwd, timeout)
  if (exitCode === 0) { emit({ status: 'pass', attempts: 1 }); return { name, passed: true, attempts: 1, output: stdout } }

  if (onFail === 'autofix') {
    const fix = await runShell(autofixCmd, cwd, timeout)
    if (fix.exitCode !== 0) {
      emit({ status: 'fail', exitCode: fix.exitCode, autofixFailed: true })
      throw new GateError(name, fix.exitCode, fix.stdout, 'autofixCmd failed')
    }
    // autofix 后重跑检查，确认真的修好了
    const re = await runShell(cmd, cwd, timeout)
    if (re.exitCode !== 0) {
      emit({ status: 'fail', exitCode: re.exitCode, autofixFailed: true })
      throw new GateError(name, re.exitCode, re.stdout, 'still failing after autofix')
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
  throw new GateError(name, exitCode, stdout)
}

/**
 * 顺序（默认）或并发跑多个门；任意门红灯（rollback / resume-fix 仍失败）即抛错。
 *
 * @param {object[]} gates
 * @param {object} [deps]
 *   - parallel  {boolean}  true = 并发跑所有门（适合独立门如 lint/type-check/unit-test）。
 *               注意：resume-fix 门依赖 agent 修复上下文，并发时多个门同时修复可能冲突，
 *               建议只对 rollback/autofix 策略的门开并发，resume-fix 门保持串行。
 *               默认 false（保持向后兼容）。
 * @returns {Promise<Array>}
 */
export async function runGates(gates, deps = {}) {
  if (deps.parallel) {
    // resume-fix 门依赖 agent 修复上下文，并发时多个门同时修复会冲突（修复结果互相覆盖）。
    // 自动检测：有任意 resume-fix 门时降级为串行，打 warn 提醒配置方。
    const hasResumeFix = gates.some(g => (g.onFail ?? 'rollback') === 'resume-fix')
    if (hasResumeFix) {
      const names = gates.filter(g => (g.onFail ?? 'rollback') === 'resume-fix').map(g => g.name).join(', ')
      console.warn(`  [runGates] parallel=true 但门 [${names}] 为 resume-fix 策略，已自动降级为串行执行以避免修复冲突`)
    } else {
      return parallel(gates.map(g => () => runGate(g, deps)), { strict: true })
    }
  }
  const results = []
  for (const g of gates) results.push(await runGate(g, deps))
  return results
}

// ── loadGates：业务项目自定义质量门（外置配置，与 provider/agent 对称）⭐ ──
//
// 让「跑哪些门」从 flow 代码外移到项目仓 <repo>/.flowcast/gates.{json,yaml,…}（committed），
// 补齐 CLAUDE.md 配置分层里「项目特定质量门放项目仓」这一长期缺位的能力。
// 复用 provider.js 的通用多层加载（~/.flowcast → <repo>/.flowcast，后者覆盖前者）。
//
// 配置形态（map by name，便于多层按门名覆盖）：
//   { "gates": {
//       "e2e": { "cmd": "sh ./scripts/e2e.sh", "onFail": "rollback", "timeout": 600000 }
//   } }
// 也接受裸 map（省去外层 "gates" 包裹）。门名取自 key；门字段与 runGate 一致
// （cmd / onFail / autofixCmd / cwd / timeout）。
//
// cmd 不在 flowcast 层做 ${VAR} 插值——门命令走 sh -c，shell 自身负责变量展开，
// 这样项目门可以自由引用 $HOME 等而不触发 provider 那套缺变量 fail-fast。

/**
 * 加载并合并多层质量门配置，返回有序门数组（机器级在前，项目级新增门追加在后；
 * 同名门项目级整体覆盖机器级）。每个门对象注入 name（取自 map 的 key）。
 *
 * @param {object} [o]
 * @param {string}   [o.repo]  项目根（查 <repo>/.flowcast/gates.*，向后兼容 .flowx/）
 * @param {string[]} [o.dirs]  完全覆盖默认搜索目录（测试用）
 * @returns {Promise<Array<{name:string} & object>>}
 */
export async function loadGates({ repo, dirs } = {}) {
  const map = await loadMergedConfig(basenamesFor('gates'), { repo, dirs, key: 'gates' })
  return Object.entries(map).map(([name, gate]) => {
    if (!gate || typeof gate !== 'object') {
      throw new Error(`质量门 '${name}' 配置必须是对象（含 cmd 等字段）`)
    }
    if (!gate.cmd) throw new Error(`质量门 '${name}' 缺少 cmd`)
    return { name, ...gate }
  })
}

/**
 * 合并「内置默认门」与「项目自定义门」，按门名去重（项目级同名覆盖内置），
 * 内置门保持原序在前，项目新增门追加在后。flow 用它把硬编码的语言默认门
 * （如 cargo test/clippy/fmt）与项目 .flowcast/gates.json 的门拼成最终门链。
 *
 * @param {object[]} builtin  内置默认门数组
 * @param {object[]} project  项目自定义门数组（通常来自 loadGates）
 * @returns {object[]}
 */
export function mergeGates(builtin = [], project = []) {
  const byName = new Map(builtin.map((g) => [g.name, g]))
  const order = builtin.map((g) => g.name)
  for (const g of project) {
    if (!byName.has(g.name)) order.push(g.name)
    byName.set(g.name, g)
  }
  return order.map((name) => byName.get(name))
}
