#!/usr/bin/env node
/**
 * Planner-Generator-Evaluator flow — Anthropic harness 设计的 flowcast 表达。
 *
 * 参考：https://www.anthropic.com/engineering/harness-design-long-running-apps
 *
 * 三个角色：
 *   Planner    — 1-4 句需求 → 完整 spec（结构化输出，落盘 spec.md）
 *   Generator  — 按 spec/sprint 实现，每轮自评后交付
 *   Evaluator  — 独立 prompt、被 tune 成 skeptical；按 contract 逐条验收，输出可执行 bug list
 *
 * 协调机制（原文核心）：sprint contract 闭环
 *   1) Generator 读 spec → 起草本轮 sprint contract（要做什么 / 怎么验证）
 *   2) Evaluator 评审 contract → agreed=true/false（false 时回写修改建议）
 *   3) 双方一致后 Generator 才动代码 → 跑质量门（lint/test/build）
 *   4) Evaluator 用同份 contract 验收 → 输出 verdict {criterion, pass, file?, line?, note?}[]
 *   5) 有 fail → 进 repair loop（maxRounds 封顶），Generator 按 bug list 修，Evaluator 复验
 *
 * 用法：
 *   flowcast run pge --goal "给登录页加 remember me 复选框" --repo .
 *   flowcast run pge --goal "..." --agent claude-sonnet --planner planner --evaluator reviewer
 *   flowcast run pge --goal "..." --dry-run          # 结构冒烟，不烧 API
 *   flowcast run pge --goal "..." --run-id xxx       # 续跑（断点恢复）
 *
 * agent profile（在 ~/.flowcast/agents.json 或 <repo>/.flowcast/agents.json 声明）：
 *   - 默认 planner = `<agent>-planner`、generator = `<agent>`、evaluator = `<agent>-evaluator`
 *   - 也可用 --planner / --generator / --evaluator 显式覆盖
 *   - evaluator profile 的 systemPrompt 应明确「skeptical、不许放水、有疑虑即 fail」
 *
 * 跨语言适配（三件套配置，都在 <repo>/.flowcast/ 下）：
 *   - gates.json   — 质量门（构建/测试/lint 命令 + onFail 策略）。各技术栈差异在此表达，
 *                    flow 代码不写死任何构建工具。无 gates.json 时不跑门。
 *   - agents.json  — planner/generator/evaluator 用哪个 CLI profile（claude/codex/gagy…）。
 *   - hygiene.md   — 该仓的卫生铁律（模块注册约定、依赖管理、代码规范等），注入到
 *                    Generator 的 build/repair prompt。无 hygiene.md 时退化为语言无关的
 *                    通用铁律（GENERIC_HYGIENE，不提具体构建工具）。
 *   样板见 flowcast/.flowcast/（Rust 铁律示例）。TS/Python 仓各写自己的 hygiene.md。
 */
import { parseArgs } from 'util'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runAgent,
  loadGates, mergeGates, runGates,
  runStructured,
  loop,
  notify, setHitlBackend,
  captureBaseline, gitWorktreeAdd, gitWorktreeRemove,
  flowcastDir, isDryRun,
} from 'flowcast'

const { values: opts } = parseArgs({ options: {
  'run-id':       { type: 'string' },
  repo:           { type: 'string', default: process.cwd() },
  goal:           { type: 'string' },
  agent:          { type: 'string', default: 'claude' },
  planner:        { type: 'string' },
  generator:      { type: 'string' },
  evaluator:      { type: 'string' },
  'reviewer-agent':   { type: 'string' },             // cross-provider review 的 agent profile
  'no-review':    { type: 'boolean', default: false }, // 跳过 review
  'max-rounds':   { type: 'string', default: '5' },   // repair loop 轮数上限
  'max-sprints':  { type: 'string', default: '8' },   // sprint 数上限（防止 planner 失控）
  workdir:        { type: 'string' },                 // 默认 <repo>/.flowcast/pge/<run-id>/
  'allow-dirty-gates': { type: 'boolean', default: false }, // baseline gate 健康检查：
                                                            //   false（默认）= gate 在 main 上就红 → 报错中止
                                                            //   true = 标记这些 gate 为"只记录不 resume-fix"
  'dry-run':      { type: 'boolean', default: false },
  hitl:           { type: 'string', default: 'terminal' },
  'project-name': { type: 'string', default: 'flowcast' },
  // ── preserve/rescue 命令 ──
  'land-preserve':    { type: 'string' },  // 把指定 run-id 的 preserve 现场跑门后 land 到 main
  'prune-preserve':   { type: 'string' },  // 清理指定 run-id 的 preserve 现场
} })

if (opts['dry-run']) process.env.FLOWCAST_DRY_RUN = '1'

const runId      = opts['run-id'] ?? `pge-${Date.now()}`
const repo       = opts.repo
const goal       = opts.goal ?? ''
const maxRounds  = parseInt(opts['max-rounds'], 10)
const maxSprints = parseInt(opts['max-sprints'], 10)

if (!goal && !isDryRun()) {
  console.error('用法：flowcast run pge --goal "..." [--repo .] [--agent claude] [--dry-run]')
  process.exit(2)
}

setWorkdir(repo)
setHitlBackend(opts.hitl === 'wecom' ? 'wecom' : 'terminal', { projectName: opts['project-name'] })

const cp       = new Checkpoint(runId, flowcastDir(repo) + '/runs')
const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

// 共享工作目录：三个 agent 通过这里的文件做 handoff（spec.md / contract.md / verdict.json / bugs.md）
const workdir = opts.workdir ?? join(flowcastDir(repo), 'pge', runId)
mkdirSync(workdir, { recursive: true })

// ── worktree 隔离 ──────────────────────────────────────────────────────
// Generator/Evaluator 在隔离的 git worktree 里改代码，不污染主仓工作区。
// worktree 生命周期是 per-run（所有 sprint 共享同一个 worktree，渐进累积改动）。
// dry-run 不创建 worktree（无真实 git 操作）。
const worktreeDir = isDryRun() ? repo : join(repo, '.worktrees', `pge-${runId}`)

// preflight 捕获的 main HEAD sha，供 landToMain / crossProviderReview / preserveScene 用。
// 必须放模块作用域（而非 main 内）：preserveScene 是顶层函数，闭包链走 module，
// 若 baseline 只在 main 里声明，preserveScene 拿不到 → diff 导出报 "baseline is not
// defined"（实测 pge-val-1785819383）。也必须在 dispatch（await main()）之前声明，
// 否则 main 跑到赋值行时还处在 TDZ（实测 pge-v2-20260804-142837）。
let baseline = null

// baseline gate 健康检查的结果：在 main（干净 worktree）上就红的 gate 名字集合。
// --allow-dirty-gates 时，sprintGates() 会把这些 gate 的 onFail 改为 'rollback'
// （失败只记录、不触发 resume-fix，避免 Generator 被迫修无关的 pre-existing lint 债务）。
// 严格模式（默认）下这个集合非空会直接在 preflight 报错中止，根本不会跑到 sprint。
const dirtyGates = new Set()

// 受控的 git 操作 helper（在 worktree 或主仓里跑 git 命令）。
function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// 把 pattern 幂等追加到 .git/info/exclude，防产物入 git（recursive 的做法）。
function ensureGitExclude(repoDir, pattern) {
  const excludePath = join(repoDir, '.git', 'info', 'exclude')
  const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (!content.split('\n').includes(pattern)) {
    writeFileSync(excludePath, content + (content && !content.endsWith('\n') ? '\n' : '') + pattern + '\n')
  }
}

// 从 goal 文本派生干净的 commit message subject（≤60 字符）。
function goalSubject() {
  const firstLine = goal.split('\n')[0]?.replace(/^#+\s*/, '').trim() || 'pge result'
  return firstLine.slice(0, 60)
}


// 角色派生：默认从 <agent> 派生 <agent>-planner / <agent>-evaluator。
// 如果派生出的 profile 不存在（常见：用户只配了基础 profile 如 'minimax'），
// 自动回退到基础 profile。pge 的 prompt 已定义各角色职责，不需要不同 profile。
const GENERATOR = opts.generator ?? opts.agent
const PLANNER   = opts.planner ?? (agents[`${opts.agent}-planner`]   ? `${opts.agent}-planner`   : opts.agent)
const EVALUATOR = opts.evaluator ?? (agents[`${opts.agent}-evaluator`] ? `${opts.agent}-evaluator` : opts.agent)

// ── 项目卫生铁律（可外置到 <repo>/.flowcast/hygiene.md）─────────────────
// 各技术栈的卫生铁律差异大（Rust 的 mod.rs 注册 vs TS 的模块导出 vs Python 的
// import 约定），不应硬编码在 flow 里。从 <repo>/.flowcast/hygiene.md 读取；
// 不存在则退化为语言无关的通用铁律（GENERIC_HYGIENE）。
function loadHygiene(repo) {
  const p = join(flowcastDir(repo), 'hygiene.md')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const hygiene = loadHygiene(repo)

// 语言无关的最小铁律——没有 hygiene.md 时的兜底（不提具体构建工具）。
const GENERIC_HYGIENE = [
  '- **新代码要有对应测试**：每个验收点都应有覆盖它的测试，不要只改实现不写测试。',
  '- **不遗留调试代码**：删掉 console.log / println! / pdb 断点 / 临时探查脚本；',
  '  工作树 git status 必须干净，不允许遗留可执行文件或临时二进制。',
  '- **改动前先读相关现有代码**：匹配既有命名风格、目录结构、错误处理模式，',
  '  不要引入与代码库不一致的范式。',
  '- **外部依赖的 API 形状要读源码确认**：用了不确定的库 API（字段名、返回类型、',
  '  必填参数）时，读 node_modules / site-packages / ~/.cargo/registry/src/ 下的',
  '  真实源码确认，不要凭记忆写——这是最常见的失败模式。',
].join('\n')

const HYGIENE_BLOCK = hygiene
  ? `## 项目卫生铁律（必须遵守）\n${hygiene}`
  : `## 通用卫生铁律（本仓未声明 .flowcast/hygiene.md，遵循以下通用规范）\n${GENERIC_HYGIENE}`

// ── schemas ────────────────────────────────────────────────────────────
const specSchema = {
  type: 'object',
  required: ['title', 'sprints'],
  properties: {
    title:   { type: 'string' },
    summary: { type: 'string' },
    sprints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'userStories'],
        properties: {
          name:       { type: 'string' },
          userStories:{ type: 'array', items: { type: 'string' } },
          notes:      { type: 'string' },
        },
      },
    },
  },
}

const contractSchema = {
  type: 'object',
  required: ['sprint', 'criteria'],
  properties: {
    sprint:    { type: 'string' },
    summary:   { type: 'string' },
    criteria:  {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'behavior'],
        properties: {
          id:       { type: 'string' },
          behavior: { type: 'string' },
          how:      { type: 'string' },
        },
      },
    },
  },
}

const contractReviewSchema = {
  type: 'object',
  required: ['agreed', 'feedback'],
  properties: {
    agreed:   { type: 'boolean' },
    feedback: { type: 'string' },
  },
}

const verdictSchema = {
  type: 'object',
  required: ['overall', 'findings'],
  properties: {
    overall:  { type: 'string', enum: ['pass', 'fail'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'status'],
        properties: {
          criterion: { type: 'string' },
          status:    { type: 'string', enum: ['pass', 'fail'] },
          file:      { type: 'string' },
          line:      { type: 'number' },
          note:      { type: 'string' },
          repro:     { type: 'string' },
        },
      },
    },
  },
}

// ── helpers ────────────────────────────────────────────────────────────
// dry-run 下 resolveAgent 仍要求 profile 存在，故 dry-run 走 runAgent（不依赖 profile），
// 非 dry-run 走 profile 解析（带 provider/extraArgs/timeout）。
// Generator/Evaluator 在 worktree 里跑（cwd: worktreeDir），不污染主仓工作区。
async function runProfile(agentName, taskGoal, extra = {}) {
  if (isDryRun()) return runAgent(taskGoal, { cli: guessCli(agentName), cwd: repo, ...extra })
  const a = resolveAgent(agentName, agents, { providers })
  return a.run(taskGoal, { __cli: a.executor, cwd: worktreeDir, ...a.opts, ...extra })
}

/**
 * Build a `resumeFix` callback for the sprint repair-loop's quality gates.
 *
 * flowcast's `runGate` calls `resumeFix(failureOutput, gate)` when a gate with
 * `onFail: 'resume-fix'` fails. The callback's job is to apply a fix in-process
 * (here: spawn the generator with the failure output as a repair prompt); runGate
 * then re-runs the gate command itself and returns pass/fail.
 *
 * This bridges the gap between pge's existing "next-loop-turn reads bugs.md"
 * repair model and the gate layer's "resume-fix retries inline" model. Without
 * this callback, runGate throws a ConfigError on any resume-fix gate failure and
 * the entire flow crashes (observed when sprint-1 hit the e2e gate).
 *
 * The callback is sprint-scoped (closes over idx) so the failure output is also
 * persisted to `sprint-<idx>-bugs.md` for the next loop turn's generator to read.
 *
 * @param {number} idx  sprint index (1-based)
 * @returns {async (failureOutput: string, gate: object) => boolean}
 */
function makeResumeFix(idx) {
  return async (failureOutput, gate) => {
    if (isDryRun()) return true
    // Persist the failure so the next loop turn's generator can read it even if
    // resume-fix's in-place retry doesn't fully converge.
    write(
      `sprint-${idx}-bugs.md`,
      `Quality gate "${gate.name}" failed (exit ${gate.exitCode ?? 'n/a'}):\n\n` +
      '```\n' + (failureOutput ?? '').slice(0, 4000) + '\n```\n',
    )
    await runProfile(
      GENERATOR,
      `你是 Generator。质量门 "${gate.name}" 失败了，请按下面的失败输出逐条修复：

${(failureOutput ?? '').slice(0, 2000)}${(failureOutput?.length ?? 0) > 2000 ? '\n\n[… 失败输出已截断，完整内容见 sprint-' + idx + '-bugs.md]' : ''}

sprint：见 sprint-${idx}-contract.md
contract（验收点以此为准）：
${read(`sprint-${idx}-contract.md`) ?? ''}

修复要求：
- 不要重新设计，只针对失败点修
- 修完后自评一遍，确认这条门能过

${HYGIENE_BLOCK}`,
    )
    // 返回 true 表示「已应用修复」；runGate 会重跑 gate 命令验证。
    return true
  }
}

async function structured(agentName, taskGoal, schema, opts = {}) {
  if (isDryRun()) return dryRunStruct(taskGoal, schema)
  const a = resolveAgent(agentName, agents, { providers })
  return runStructured(
    (p) => a.run(p, { __cli: a.executor, cwd: worktreeDir, ...a.opts }),
    taskGoal,
    { schema, retries: 2, ...opts },
  )
}

function guessCli(agentName) {
  // 从 agent 名前缀推个合理的 cli；unknown 一律 claude
  if (agentName.startsWith('cursor')) return 'cursor'
  if (agentName.startsWith('gemini')) return 'gemini'
  if (agentName.startsWith('codex'))  return 'codex'
  if (agentName.startsWith('aider'))  return 'aider'
  if (agentName.startsWith('agy'))    return 'agy'
  return 'claude'
}

function write(name, content) {
  writeFileSync(join(workdir, name), content)
}
function read(name) {
  const p = join(workdir, name)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

// dry-run 下提供 fake agent（让骨架可走通），否则交给真实 CLI
async function dryRunStruct(_taskGoal, schema) {
  if (schema === specSchema) {
    return { title: '[dry-run] spec', summary: goal, sprints: [{ name: 'sprint-1', userStories: ['hello'], notes: '' }] }
  }
  if (schema === contractSchema) {
    return { sprint: 'sprint-1', summary: '[dry-run] contract', criteria: [{ id: 'c1', behavior: 'it works', how: 'manual' }] }
  }
  if (schema === contractReviewSchema) {
    return { agreed: true, feedback: '[dry-run] looks good' }
  }
  if (schema === verdictSchema) {
    return { overall: 'pass', findings: [{ criterion: 'c1', status: 'pass' }] }
  }
  return {}
}

// ── main ───────────────────────────────────────────────────────────────
// 进程级 failsafe：wall-clock 超时防止 agent 调用卡死导致整个 flow 永远 running。
// 单次 agent 调用有 profile.timeout 兜底，但多个 sprint × 多轮 repair 累积时间可能很长。
// 超时后记一笔并非零退出，让 supervisor 知道 flow 没正常结束。
const PGE_WALL_CLOCK_MS = parseInt(process.env.PGE_WALL_CLOCK_MS ?? '', 10) || 0
const wallClockAbort = PGE_WALL_CLOCK_MS > 0
  ? setTimeout(() => {
      console.error(`\n[wall-clock] pge 超时（${PGE_WALL_CLOCK_MS / 60000}min），强制退出。`)
      console.error(`workdir: ${workdir}`)
      console.error(`用 --run-id ${runId} 续跑（已完成 sprint 会被 checkpoint 跳过）。`)
      cp.done({ wallClockTimeout: true })
      process.exit(3)
    }, PGE_WALL_CLOCK_MS)
  : null
if (wallClockAbort) wallClockAbort.unref?.()

// signal handler：SIGINT/SIGTERM 时不删 worktree（保留现场供用户接管）。
// 不在此处 process.exit——让默认的 exit 路径走，只是确保 cleanup 不执行。
process.on('SIGINT', () => {
  console.error('\n[signal] SIGINT 收到，worktree 保留在 ' + worktreeDir + '，不清理。')
  cp.done({ signalInterrupted: true })
  process.exit(130)
})

// ── 全局错误捕获（待修 2：agent 调用挂死）──────────────────────────────────
// 复盘现象：claude CLI 子进程退出后 node 主进程也退出（pgrep 找不到进程），
// 但 state.json 还停在 running——没有任何 error 输出或 verdict。根因是某个
// 异步路径抛了 uncaughtException / unhandledRejection，node 默认崩掉但没机会
// 把原因落盘。这里把原因写到 cp.done（state.json）+ stderr，让下次崩溃能看到
// 为什么死的，并保留 worktree 现场供排查。
//
// 注意：这两个 handler 必须在 dispatch 之前注册——覆盖 main()/landPreserve()/
// prunePreserve() 整个执行期。dry-run 时 worktreeDir === repo，不能删，因此
// 只在非 dry-run 时提示保留 worktree。
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err)
  try { cp.done({ fatalError: (err?.stack ?? String(err)).slice(0, 500) }) } catch {}
  if (!isDryRun() && existsSync(worktreeDir)) {
    console.error('[FATAL] worktree 保留:', worktreeDir)
  }
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason)
  try { cp.done({ fatalRejection: String(reason?.stack ?? reason).slice(0, 500) }) } catch {}
  if (!isDryRun() && existsSync(worktreeDir)) {
    console.error('[FATAL] worktree 保留:', worktreeDir)
  }
  process.exit(1)
})

// ── preserve/rescue 命令 dispatch（在 main 之前）──
// 这些命令消费之前失败 run 保留的现场，不走正常 sprint 流程。
if (opts['land-preserve']) {
  await landPreserve(opts['land-preserve'])
} else if (opts['prune-preserve']) {
  prunePreserve(opts['prune-preserve'])
} else {
  await main()
}
// 成功完成 → 清理 worktree。失败（throw）时不执行到这里，worktree 自然保留。
if (!isDryRun() && existsSync(worktreeDir)) {
  try {
    gitWorktreeRemove(repo, worktreeDir)
    console.log(`[worktree] 已清理: ${worktreeDir}`)
  } catch (e) {
    console.log(`[worktree] 清理失败（可能 git worktree remove 报锁，手动删即可）: ${e.message?.slice(0, 80)}`)
  }
}
if (wallClockAbort) clearTimeout(wallClockAbort)

async function main() {
  // ── Phase 0: preflight（worktree 隔离）──
  // dry-run 跳过所有 git 操作。
  if (!isDryRun()) {
    baseline = await cp.step('preflight.baseline', () => {
      return captureBaseline(repo, { requireClean: true })
    })
    await cp.step('preflight.worktree', () => {
      ensureGitExclude(repo, '.worktrees/')
      if (!existsSync(worktreeDir)) {
        gitWorktreeAdd(repo, worktreeDir)
        console.log(`[worktree] 创建隔离工作目录: ${worktreeDir}`)
      } else {
        console.log(`[worktree] 复用已有工作目录（续跑）: ${worktreeDir}`)
      }
    })
    // baseline gate 健康检查：在干净的 worktree（== main）上空跑一遍所有 gate。
    // 如果某个 gate 在 baseline 就红，说明 main 上有 pre-existing 的 lint/test 债务。
    // 不查就跑，resume-fix 会把这些无关债务塞给 Generator，耗尽 budget（实测 v3：
    // ruff 在 main 上有 35 个 pre-existing error，Generator 被迫修了 12 个 Python
    // 文件的 import 风格，30min 超时）。这里把"修 lint 债务"的责任交还给人。
    await cp.step('preflight.gate-check', async () => {
      const gates = await sprintGates()
      if (gates.length === 0) return { checked: 0 }
      // 用 no-op resumeFix + onExhausted:'return-fail' 跑一遍：失败不 throw、不修复，
      // 只拿 pass/fail 结果。cwd 用 worktreeDir（此刻 worktree == main，无任何改动）。
      const probed = gates.map(g => ({ ...g, cwd: g.cwd ?? worktreeDir }))
      const results = await runGates(probed, {
        resumeFix: async () => false,  // 探测模式：不修复，直接让 gate 返回 fail
        onExhausted: 'return-fail',
      })
      const failed = results.filter(r => !r.passed)
      if (failed.length === 0) {
        console.log(`  [gate-check] ${results.length} 个 gate 在 baseline 全绿`)
        return { checked: results.length, dirty: [] }
      }
      const dirtyNames = failed.map(r => r.name)
      dirtyNames.forEach(n => dirtyGates.add(n))
      const msg = `baseline gate 健康检查：以下 gate 在 main（干净 worktree）上就是红的：\n` +
        failed.map(r => `  - ${r.name}（exit ${r.exitCode ?? 'n/a'}）`).join('\n') +
        `\n\n这意味着 main 上有 pre-existing 的 lint/test/build 债务。继续跑会让\n` +
        `resume-fix 把这些无关债务塞给 Generator，耗尽 budget。`
      if (opts['allow-dirty-gates']) {
        console.log(`  [gate-check] ⚠️ ${failed.length} 个 gate 在 baseline 就红（--allow-dirty-gates）：`)
        console.log(failed.map(r => `    - ${r.name}`).join('\n'))
        console.log(`  [gate-check] 这些 gate 将从 sprint gates 中跳过（不跑、不判 fail、不触发 repair）`)
        return { checked: results.length, dirty: dirtyNames, downgraded: true }
      }
      // 严格模式：报错中止，把修 baseline 的责任交还给人
      const err = new Error(
        msg + `\n\n请先在 main 上修干净这些 gate（例如 \`cd <repo> && <gate-cmd>\`），\n` +
        `commit 后再跑 pge。或用 --allow-dirty-gates 让这些 gate 从 sprint 中跳过。`,
      )
      err.code = 'DIRTY_BASELINE_GATE'
      err.dirtyGates = dirtyNames
      throw err
    })
  }

  // ── Phase 1: Planner ──
  const spec = await cp.step('plan', async () => {
    const prompt = `你是 Planner。把下面简短需求扩展成完整产品 spec：
- 关注产品上下文与高层技术设计，不要写太细的实现（怕错 cascade）
- **忠于用户需求，不要扩大 scope**：用户没要求的功能不要擅自加。
  如果需求看起来简单，spec 就简单——1 个 sprint 就够。
- **不要强行加 AI 功能**：只在需求明确涉及 AI 时才加。
- 拆成 ${maxSprints} 个以内的 sprint，每个 sprint 一组用户故事。
  简单需求通常 1-2 个 sprint 足矣，不要为了凑数拆。

需求：${goal}

${read('spec.md') ? `（注意：spec 已存在，可能是续跑。若存在请尽量复用，除非明显有问题。）` : ''}
输出严格符合 schema。`
    const out = await structured(PLANNER, prompt, specSchema)
    write('spec.md', `# ${out.title}\n\n${out.summary}\n\n## Sprints\n` +
      out.sprints.map((s, i) => `### ${i + 1}. ${s.name}\n${s.userStories.map(u => `- ${u}`).join('\n')}\n${s.notes ? `\n${s.notes}\n` : ''}`).join('\n'))
    return out
  })

  console.log(`\n[planner] ${spec.title} — ${spec.sprints.length} sprint(s)`)

  // ── Phase 2: per-sprint build-eval-repair loop ──
  // Sprint 依赖门：当前 sprint verdict 失败时不进下一个 sprint（避免越滚越大的烂代码）。
  // 之前 pge 会静默进下一个 sprint 累积半成品代码，是 pge-p2b 翻车的核心原因。
  // 现在：verdict fail → raise 清晰错误，main 捕获后停止整个 flow，让用户决定（手动
  // 接管 / 改 spec / 修 prompt）。
  for (let i = 0; i < spec.sprints.length && i < maxSprints; i++) {
    const sprint = spec.sprints[i]
    const tag = `sprint-${i + 1}-${sprint.name.replace(/\s+/g, '_').slice(0, 30)}`

    try {
      await cp.step(tag, () => runSprint(sprint, i + 1))
    } catch (e) {
      console.log(`  [abort] sprint ${i + 1} (${sprint.name}) 失败：${e.message?.slice(0, 200) ?? e}`)
      // preserve 现场（WIP commit + ref + diff + failure log），不硬回滚
      const preserved = preserveScene({ reason: e.message?.slice(0, 200) ?? String(e), failureOutput: e.stack })
      cp.done({ sprints: spec.sprints.length, maxRounds, abortedAt: i + 1, reason: e.message, verdict: preserved.verdict })
      await notify(`pge 中止：sprint ${i + 1} 失败（${preserved.verdict}）\n恢复: --land-preserve ${runId}`)
      console.log(`\n✗ pge 中止在 sprint ${i + 1}（${preserved.verdict}）。worktree: ${worktreeDir}`)
      throw e
    }
  }

  // ── Phase 3a: cross-provider review（所有 sprint 通过后、commit 前）──
  // 用不同 provider 做二次审查，防 Generator 自评放水。
  if (!isDryRun()) {
    const reviewVerdict = await crossProviderReview(baseline)
    if (reviewVerdict === 'needs-fix') {
      // review 循环耗尽 → preserve（代码可能是对的，只是 reviewer 不满意）
      const preserved = preserveScene({ reason: 'cross-provider review 未通过', failureOutput: 'review rounds exhausted' })
      cp.done({ sprints: spec.sprints.length, maxRounds, verdict: preserved.verdict, reviewFailed: true })
      await notify(`pge：review 未通过（${preserved.verdict}）\n恢复: --land-preserve ${runId}`)
      console.log(`\n✗ review 未通过（${preserved.verdict}）。worktree: ${worktreeDir}`)
      return  // 不 land，不 throw（让 cleanup 保留 worktree）
    }
    if (reviewVerdict === 'unavailable') {
      console.log('  [review] reviewer 不可用，跳过 review 直接 land（门已过 + evaluator 已过）')
    }
  }

  // ── Phase 3b: commit + land（review 通过后）──
  // 把 worktree 里累积的改动提交到 main。
  if (!isDryRun()) {
    await cp.step('commit.land', () => landToMain(baseline))
  }

  cp.done({ sprints: spec.sprints.length, maxRounds, landed: !isDryRun() })
  await notify(`pge 完成：${spec.title}（${spec.sprints.length} sprints）${isDryRun() ? '' : '，已落地 main'}`)
  console.log(`\n✓ pge 完成。产物在 ${workdir}`)
}

/**
 * 把 worktree 的改动 land 到 main checkout。
 *
 * 移植自 recursive self-improve 的 commit.prep + commit.land 逻辑：
 *   1. worktree 内 git add -A + commit（拿到 wtSha）
 *   2. 检查 main 是否被推进（mainMoved）
 *   3. 快路径：main 没动 → cherry-pick --no-commit + 显式 commit
 *   4. 慢路径：main 动了 → warn 并跳过（pge 不做 rebase+regate，让用户手动处理）
 *
 * @param {string} baseline  preflight 时捕获的 main HEAD sha
 */
function landToMain(baseline) {
  // worktree 内提交
  git(['add', '-A'], worktreeDir)
  const status = git(['status', '--porcelain'], worktreeDir)
  if (!status) {
    console.log('  [land] worktree 无改动，跳过 commit')
    return { empty: true }
  }
  git(['commit', '-m', `wt: ${goalSubject()}`], worktreeDir)
  const wtSha = git(['rev-parse', 'HEAD'], worktreeDir)
  const mainHead = git(['rev-parse', 'HEAD'], repo)
  const mainMoved = mainHead !== baseline

  if (mainMoved) {
    // 慢路径：main 被外部推进了（并发 flow / 手动 commit）。
    // pge 不做 rebase+regate（太复杂）——保留 worktree 让用户决定。
    console.log(`  [warn] main 已从 ${baseline.slice(0, 8)} 推进到 ${mainHead.slice(0, 8)}（可能并发 flow 或手动 commit）`)
    console.log(`  [warn] worktree 保留在 ${worktreeDir}，改动已 commit 为 wtSha ${wtSha.slice(0, 8)}`)
    console.log(`  [warn] 手动 cherry-pick: git cherry-pick ${wtSha.slice(0, 8)}`)
    return { mainMoved: true, wtSha }
  }

  // 快路径：main 没动 → cherry-pick 到 main
  try {
    git(['cherry-pick', '--no-commit', wtSha], repo)
  } catch (e) {
    try { git(['cherry-pick', '--abort'], repo) } catch {}
    throw new Error(`cherry-pick 冲突 landing ${wtSha.slice(0, 8)}: ${e.message}`)
  }
  git(['commit', '-m', `feat: ${goalSubject()}`], repo)
  const landedSha = git(['rev-parse', 'HEAD'], repo)
  console.log(`  [land] 已落地 main: ${landedSha.slice(0, 8)}`)
  return { landed: true, sha: landedSha }
}

// ── preserve/rescue：失败时保留现场，供后续消费 ──────────────────────────
// 移植自 recursive self-improve 的 preserveScene。
// 保留 4 样东西：WIP commit、refs/preserve/<runId>、preserved.diff、failure log。

/**
 * 保留失败现场。不硬回滚——worktree 里的 WIP 代码是有价值的。
 *
 * @param {object} args
 * @param {string} args.reason  失败原因
 * @param {string} [args.failureOutput]  失败输出（stderr/log 尾部）
 * @returns {{ verdict: string, ref: string, wtSha: string }}
 */
function preserveScene({ reason, failureOutput }) {
  // ① worktree 内提交 WIP（哪怕测试红也先 commit，拿完整代码状态）
  try { git(['add', '-A'], worktreeDir) } catch {}
  let wtSha
  try {
    git(['commit', '-m', `preserve: ${reason.slice(0, 60)}`], worktreeDir)
    wtSha = git(['rev-parse', 'HEAD'], worktreeDir)
  } catch {
    // 无改动时 commit 失败，用当前 HEAD
    wtSha = git(['rev-parse', 'HEAD'], worktreeDir)
  }

  // ② 打 preserve ref（不占 worktree slot，可被多处引用）
  const ref = `refs/preserve/${runId}`
  try {
    git(['update-ref', ref, wtSha], repo)
  } catch (e) {
    console.log(`  [preserve] update-ref 失败（不影响主流程）: ${e.message?.slice(0, 80)}`)
  }

  // ③ 导出 diff 到 run 目录（worktree 被删也能看改动）
  // baseline 可能为 null（preflight 未完成就崩了）→ 退化为 diff HEAD（仅 worktree 内未提交改动）。
  const diffDir = flowcastDir(repo) + '/runs/' + runId
  try {
    const diff = baseline
      ? git(['diff', `${baseline}..${wtSha}`], repo)
      : git(['diff', 'HEAD'], worktreeDir)
    writeFileSync(join(diffDir, 'preserved.diff'), diff || '')
  } catch (e) {
    console.log(`  [preserve] diff 导出失败: ${e.message?.slice(0, 80)}`)
  }

  // ④ 失败日志
  try {
    writeFileSync(join(diffDir, 'failure.log'), String(failureOutput ?? reason))
  } catch {}

  console.log(`  [preserve] run ${runId} 已保留:`)
  console.log(`    ref: ${ref} (${wtSha.slice(0, 8)})`)
  console.log(`    diff: ${join(diffDir, 'preserved.diff')}`)
  console.log(`    worktree: ${worktreeDir}`)
  console.log(`  恢复: --land-preserve ${runId}`)
  console.log(`  清理: --prune-preserve ${runId}`)

  return { verdict: 'failed-preserved', ref, wtSha }
}

/**
 * land-preserve：把之前失败 run 的 preserve 现场跑门后 land 到 main。
 * 不用 cherry-pick（可能丢同链更早 commit），用 merge-base + diff + apply。
 */
async function landPreserve(preserveRunId) {
  const ref = `refs/preserve/${preserveRunId}`
  let sha
  try {
    sha = git(['rev-parse', ref], repo)
  } catch {
    console.error(`错误：ref ${ref} 不存在。检查 run-id 是否正确。`)
    process.exit(1)
  }

  const mainHead = git(['rev-parse', 'HEAD'], repo)
  const ancestor = git(['merge-base', mainHead, sha], repo)

  // 用 merge-base..sha 的完整 diff（包含同链所有 commit 的累积改动）
  let fullDiff
  try {
    fullDiff = git(['diff', `${ancestor}..${sha}`], repo)
  } catch (e) {
    console.error(`无法生成 diff: ${e.message}`)
    process.exit(1)
  }

  if (!fullDiff.trim()) {
    console.log('preserve 现场无改动，无需 land。')
    process.exit(0)
  }

  // 写到临时文件（git() 的 .trim() 会剪末尾换行导致 corrupt patch，补回）
  const diffFile = join(flowcastDir(repo), 'runs', preserveRunId, 'land.diff')
  writeFileSync(diffFile, fullDiff.endsWith('\n') ? fullDiff : fullDiff + '\n')

  // apply 到主仓
  try {
    git(['apply', diffFile], repo)
  } catch (e) {
    console.error(`apply 冲突，恢复主仓: ${e.message?.slice(0, 100)}`)
    git(['checkout', '--', '.'], repo)
    git(['clean', '-fd'], repo)
    process.exit(1)
  }

  git(['add', '-A'], repo)
  git(['commit', '-m', `feat: ${goalSubject()} [land-preserve ${preserveRunId.slice(-6)}]`], repo)
  const landedSha = git(['rev-parse', 'HEAD'], repo)
  console.log(`✓ preserve ${preserveRunId} 已 land 到 main: ${landedSha.slice(0, 8)}`)
}

/**
 * prune-preserve：清理失败 run 的 preserve 现场。
 */
function prunePreserve(preserveRunId) {
  const ref = `refs/preserve/${preserveRunId}`
  try {
    git(['update-ref', '-d', ref], repo)
    console.log(`✓ 已删除 ref: ${ref}`)
  } catch {
    console.log(`ref ${ref} 不存在或已删除`)
  }
  // 清理 preserve worktree（如果挪到了 preserve 命名空间）
  const preserveWt = join(repo, '.worktrees', 'preserve', preserveRunId)
  if (existsSync(preserveWt)) {
    try {
      gitWorktreeRemove(repo, preserveWt, { force: true })
      console.log(`✓ 已删除 worktree: ${preserveWt}`)
    } catch (e) {
      console.log(`worktree 删除失败（手动删即可）: ${e.message?.slice(0, 80)}`)
    }
  }
}

// ── cross-provider review ────────────────────────────────────────────────
// 所有 sprint 通过后、commit 前的二次独立审查。用不同 provider 防自评放水。

/**
 * 跑 cross-provider review。
 * 用 --reviewer-agent 指定的 profile（默认用 evaluator profile）做一次 diff 审查。
 * NEEDS_FIX 时跑 N 轮修复循环。
 *
 * @param {string} baselineSha  preflight 的 main HEAD（用于生成 diff）
 * @returns {'pass'|'needs-fix'|'unavailable'}
 */
async function crossProviderReview(baselineSha) {
  if (opts['no-review']) return 'pass'
  if (isDryRun()) return 'pass'

  const reviewerProfile = opts['reviewer-agent'] ?? EVALUATOR
  // 生成完整 diff 给 reviewer（不截断——截断会导致假阴性 NEEDS_FIX）
  let diff
  try {
    // 先 intent-to-add 未跟踪文件让它们进 diff
    git(['add', '--intent-to-add', '-A'], worktreeDir)
    diff = git(['diff'], worktreeDir)
  } catch {
    diff = '(无法生成 diff)'
  }
  if (!diff.trim()) return 'pass'  // 无改动不需要 review

  for (let round = 0; round <= maxRounds; round++) {
    const stepName = round === 0 ? 'review' : `review.fix-${round}`
    const verdict = await cp.step(stepName, async () => {
      const result = await runProfile(
        reviewerProfile,
        `你是独立 Reviewer（与 Generator 不同 provider，防自评放水）。
审查以下完整 diff，重点检查：correctness、regressions、contract violations、安全问题。
最后一行必须恰好是 VERDICT:PASS 或 VERDICT:NEEDS_FIX。

## 完整 diff
\`\`\`diff
${diff}
\`\`\`

## Goal（原始需求）
${goal}
`,
      )
      const text = String(result)
      if (/VERDICT:\s*PASS/.test(text)) return 'pass'
      if (/VERDICT:\s*NEEDS_FIX/.test(text)) return 'needs-fix'
      return 'no-verdict'
    })

    if (verdict === 'pass') {
      console.log(`  [review] PASS (round ${round})`)
      return 'pass'
    }
    if (verdict === 'no-verdict') {
      console.log(`  [review] reviewer 未给出明确 verdict（round ${round}），视为 unavailable`)
      return 'unavailable'
    }

    // NEEDS_FIX：跑 Generator 修一轮，然后重新生成 diff
    console.log(`  [review] NEEDS_FIX (round ${round})，让 Generator 修...`)
    const reviewText = await runProfile(
      reviewerProfile,
      `你是独立 Reviewer。上面的 diff 有问题，请列出具体需要修的点（file:line + 问题描述）。
只列要修的，不要重写代码。`,
    )
    await runProfile(
      GENERATOR,
      `你是 Generator。Reviewer 对你的实现给了反馈，请逐条修复：
${reviewText}

sprint contract 参考：
${read('sprint-1-contract.md') ?? '(无 contract)'}

${HYGIENE_BLOCK}`,
    )
    // 重新生成 diff
    try { diff = git(['diff'], worktreeDir) } catch { diff = '(无法生成 diff)' }
  }

  console.log(`  [review] ${maxRounds} 轮未收敛，返回 needs-fix`)
  return 'needs-fix'
}
async function runSprint(sprint, idx) {
  console.log(`\n── sprint ${idx}: ${sprint.name} ──`)

  // 2a. 起草 contract
  const contract = await structured(
    GENERATOR,
    `你是 Generator。基于 spec 中的 sprint，起草本轮 sprint contract：
- 列出每个可测试的验收点（behavior），并写明如何验证（how）
- 不要写代码，只写「done 长什么样」

sprint：${sprint.name}
用户故事：
${sprint.userStories.map(u => `- ${u}`).join('\n')}
${sprint.notes ? `\nnotes: ${sprint.notes}\n` : ''}
${read('spec.md') ? `\n完整 spec 参考：\n${read('spec.md')}\n` : ''}
输出严格符合 schema。`,
    contractSchema,
  )
  write(`sprint-${idx}-contract.md`, `# Contract: ${contract.sprint}\n\n${contract.summary}\n\n## Criteria\n` +
    contract.criteria.map(c => `- [${c.id}] ${c.behavior}\n  - how: ${c.how}`).join('\n'))

  // 2b. Evaluator 评审 contract（不写代码，只判 agreed）
  // scope 校验（待修 1）：deepseek 等模型不遵守 Generator prompt 里的 scope 约束，
  // 常把「只加测试」的 goal 蔓延成改 11 个实现文件。在 contract 谈判阶段就拦住——
  // 把 goal 原文交给 Evaluator，让它判 contract 验收点是否超出 goal 字面 scope。
  let review = await structured(
    EVALUATOR,
    `你是 Evaluator（skeptical QA）。评审这份 sprint contract：
- 范围对不对？验收点够不够具体？有没有遗漏 spec 要求？
- 不满意就 agreed=false 并写明修改建议
- 满意才 agreed=true

- **scope 检查**：contract 的验收点是否超出 goal 的字面 scope？
  如果 goal 说"只加测试"，contract 不应包含改实现代码的验收点。
  如果 goal 指定了语言（如"TS 测试"），contract 不应包含其他语言的改动。
  超出 scope → agreed=false，要求 Generator 收缩 scope。
原始 goal（scope 以此为准）：
${goal}

contract：
${JSON.stringify(contract, null, 2)}
输出严格符合 schema。`,
    contractReviewSchema,
  )

  // 2c. 至多 2 轮 contract 谈判（防止无限循环）
  for (let r = 0; r < 2 && !review.agreed; r++) {
    const revised = await structured(
      GENERATOR,
      `Evaluator 对你的 contract 给了反馈，请修订：
${review.feedback}

原 contract：
${JSON.stringify(contract, null, 2)}
输出修订后的 contract。`,
      contractSchema,
    )
    Object.assign(contract, revised)
    write(`sprint-${idx}-contract.md`, `# Contract: ${contract.sprint} (rev ${r + 2})\n\n${contract.summary}\n\n## Criteria\n` +
      contract.criteria.map(c => `- [${c.id}] ${c.behavior}\n  - how: ${c.how}`).join('\n'))

    review = await structured(
      EVALUATOR,
      `Generator 修订了 contract，再审一次：
${review.feedback}

新 contract：
${JSON.stringify(contract, null, 2)}

- **scope 检查仍适用**：验收点不能超出 goal 字面 scope（goal 说"只加测试"就不
  该有改实现的验收点；goal 指定语言就不该有其他语言改动）。超出 → agreed=false。
原始 goal：
${goal}

agreed=true 仅当你真的满意。`,
      contractReviewSchema,
    )
  }

  if (!review.agreed) {
    console.log(`  [warn] contract 谈判 ${2} 轮未一致，按当前版本继续（evaluator 注释记入 bug list）`)
    write(`sprint-${idx}-contract-note.md`, `Contract 未达成一致。Evaluator 反馈：${review.feedback}`)
  }

  // 2d. repair loop：Generator 实现 → 质量门 → Evaluator 验收 → 有 bug 就修，直到 pass 或轮数耗尽
  const result = await loop(
    async ({ turn }) => {
      if (turn === 0) {
        // 首轮：让 generator 实现
        await runProfile(
          GENERATOR,
          `你是 Generator。按 sprint contract 实现。
- 每个验收点都要落到代码
- **严格遵守 goal 的 scope**：只改 contract 涉及的文件。如果 goal 说"只加测试"，
  就不要改实现代码。如果 goal 指定了语言（如"TS 测试"），就不要碰另一种语言。
  scope 蔓延是 pge 最常见的失败模式——Evaluator 会拒绝超出 scope 的改动。
- 实现完成后**自评一遍**：确认每个验收点的代码都写到了，确保能过质量门（见 contract 的 how 字段）
- 改动提交到 git（如果可用）

${HYGIENE_BLOCK}

- **若已读 \`sprint-${idx}-bugs.md\`**，先看清上一轮 bug 列表（gate 失败 / evaluator 失败 / findings fail），
  按列表修，不要重做不相关的部分。

sprint：${sprint.name}
contract：
${read(`sprint-${idx}-contract.md`) ?? JSON.stringify(contract)}

完整 spec：
${read('spec.md') ?? ''}`,
        )
        return { phase: 'build' }
      }

      // 后续轮：读 evaluator 上轮的 bug list 修复
      const bugs = read(`sprint-${idx}-bugs.md`) ?? ''
      await runProfile(
        GENERATOR,
        `你是 Generator。Evaluator 在上轮验收时报告了下列问题，请逐条修复：
${bugs}

sprint：${sprint.name}
contract（验收点以此为准）：
${read(`sprint-${idx}-contract.md`) ?? JSON.stringify(contract)}`,
      )
      return { phase: 'repair', turn }
    },
    {
      goal: `sprint ${idx}（${sprint.name}）所有 contract 验收点通过 Evaluator`,
      maxTurns: maxRounds,
      runId: `${runId}-sprint-${idx}`,
      stateDir: flowcastDir(repo) + '/runs',
      // 走 loop 内置的 quality gate 机制（flowcast 0.5.1+）：
      //   - maxResumeAttempts: 3 → 失败最多 3 轮 resume-fix
      //   - onExhausted: 'return-fail' → 用尽返回 {passed:false} 而非 throw，
      //     isDone 看到后写 bugs.md + return false，让 pge loop 进入下一轮 generator
      //   - resumeFix callback 写 gate report + spawn generator 修
      // 这样 pge 能用上 flowcast 原生多轮 gate 修复，不需 isDone 自己跑门。
      gates: await sprintGates(),
      gateDeps: {
        resumeFix: makeResumeFix(idx),
        maxResumeAttempts: 3,
        onExhausted: 'return-fail',
      },
      isDone: async ({ turn, gateResults = [] }) => {
        if (turn === 0 && maxRounds === 0) return true
        if (turn === 0) return false

        // ── 1. 质量门（已被 loop 跑过）──
        // loop 已经调过 runGates：gateResults 数组里每项 {name, passed, ...}
        const failed = gateResults.filter(r => !r.passed)
        if (failed.length) {
          // 兜底：loop 应该已经把失败 stdout 写进 bugs.md（resumeFix callback 里），
          // 这里再加一个综合报告让 generator 一眼看到。
          const report = failed.map(f =>
            `## Gate "${f.name}" failed (exit ${f.exitCode ?? 'n/a'})\n\n` +
            '```\n' + (f.output ?? '').slice(0, 2000) + '\n```',
          ).join('\n\n')
          write(`sprint-${idx}-bugs.md`,
            (read(`sprint-${idx}-bugs.md`) ?? '') +
            '\n\n## Gate summary\n\n' + report,
          )
          return false
        }

        // ── 2. Evaluator 按 contract 验收 ──
        // 用 onFail: 'return-null'：evaluator 模型偶尔输出非 JSON 不再 throw，
        // 返回 null；这里把 null 当作「evaluator 自己出问题」处理，return false
        // 让下一轮 generator 重新自评。
        const verdict = await structured(
          EVALUATOR,
          `你是 Evaluator（skeptical QA）。按 contract 逐条验收当前实现。
- 对每个验收点：实际运行/检查代码后判 pass/fail
- fail 必须给 file/line/note/repro（让 Generator 无需重新调查就能修）
- 默认怀疑，不许「看起来还行就放水」

contract：
${read(`sprint-${idx}-contract.md`) ?? JSON.stringify(contract)}

spec 参考：
${read('spec.md') ?? ''}
输出严格符合 schema。`,
          verdictSchema,
          { onFail: 'return-null' },
        )

        if (verdict === null) {
          console.log(`  [evaluator-fail] runStructured 3 次后仍非合法 JSON`)
          write(`sprint-${idx}-bugs.md`,
            (read(`sprint-${idx}-bugs.md`) ?? '') +
            '\n\n## Evaluator 输出失败\n\n' +
            'Evaluator 跑结构化输出失败（3 次重试仍非合法 JSON）。' +
            '这通常是 evaluator 模型自身的输出格式问题，不一定是代码错。\n' +
            '请 generator 重新自评一遍 contract 各验收点，确认实现无误。',
          )
          return false
        }

        write(`sprint-${idx}-verdict.json`, JSON.stringify(verdict, null, 2))

        const fails = verdict.findings.filter(f => f.status === 'fail')
        if (verdict.overall === 'pass' || fails.length === 0) {
          write(`sprint-${idx}-bugs.md`, '')
          return true
        }

        // 把 fail 写成 bug list 供下一轮 Generator 读
        write(`sprint-${idx}-bugs.md`, fails.map(f =>
          `- [${f.criterion}] ${f.note ?? ''}\n` +
          (f.file ? `  - file: ${f.file}${f.line ? `:${f.line}` : ''}\n` : '') +
          (f.repro ? `  - repro: ${f.repro}\n` : '')
        ).join('\n'))

        return false
      },
    },
  )

  // 兜底：loop 跑完仍未 pass，记一笔让外层知道
  const finalVerdict = read(`sprint-${idx}-verdict.json`)
  if (result.status === 'budget_exhausted' && finalVerdict && JSON.parse(finalVerdict).overall !== 'pass') {
    // 修法 A（sprint 依赖门）：verdict fail 时不再静默进下一个 sprint。
    // 抛错让 main 的 try/catch 捕获，停止整个 flow；用户可以选择手动接管 / 改 prompt / 改 spec。
    const err = new Error(
      `sprint ${idx} (${sprint.name}) 在 ${maxRounds} 轮内未通过验收。` +
      `verdict.overall = ${JSON.parse(finalVerdict).overall}。` +
      `\nworkdir: ${workdir}\n` +
      `查看 ${workdir}/sprint-${idx}-verdict.json 和 sprint-${idx}-bugs.md 了解详情。`,
    )
    err.sprint = idx
    err.sprintName = sprint.name
    err.verdict = JSON.parse(finalVerdict)
    throw err
  }
}

// 加载质量门：业务项目 .flowcast/gates.json + 内置默认（合并）。
// 若 preflight.gate-check 发现有 baseline 就红的 gate 且 --allow-dirty-gates，
// 这些 gate 从 sprint gates 里完全移除（不跑、不判 fail、不触发 repair），
// 避免 Generator 被迫修无关的 pre-existing 债务。
// 注意：不是降级 onFail——降级仍会让 gate 跑、失败后 isDone 仍判 sprint 失败
// 并触发 repair loop（实测 ilinkhub-val-1785833310074：turn-2/3 的 repair prompt
// 只有 gate summary、没有 evaluator findings，Generator 对着空 bug list 空转）。
async function sprintGates() {
  let builtin = []
  let project = []
  try { builtin = defaultGates() } catch { /* 无内置也无所谓 */ }
  try { project = await loadGates({ repo }) } catch { /* 业务项目没声明也无所谓 */ }
  const merged = mergeGates(builtin, project)
  if (dirtyGates.size > 0) {
    const skipped = merged.filter(g => dirtyGates.has(g.name))
    if (skipped.length) {
      console.log(`  [gate] 跳过 baseline 就红的 gate（--allow-dirty-gates）: ${skipped.map(g => g.name).join(', ')}`)
    }
    return merged.filter(g => !dirtyGates.has(g.name))
  }
  return merged
}

function defaultGates() {
  // 默认不强制任何门——业务项目通过 .flowcast/gates.json 声明自己的 lint/test/build。
  return []
}
