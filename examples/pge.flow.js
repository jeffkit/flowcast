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
 */
import { parseArgs } from 'util'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runAgent,
  loadGates, mergeGates, runGates,
  runStructured,
  loop,
  notify, setHitlBackend,
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
  'max-rounds':   { type: 'string', default: '5' },   // repair loop 轮数上限
  'max-sprints':  { type: 'string', default: '8' },   // sprint 数上限（防止 planner 失控）
  workdir:        { type: 'string' },                 // 默认 <repo>/.flowcast/pge/<run-id>/
  'dry-run':      { type: 'boolean', default: false },
  hitl:           { type: 'string', default: 'terminal' },
  'project-name': { type: 'string', default: 'flowcast' },
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

const PLANNER   = opts.planner   ?? `${opts.agent}-planner`
const GENERATOR = opts.generator ?? opts.agent
const EVALUATOR = opts.evaluator ?? `${opts.agent}-evaluator`

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
async function runProfile(agentName, taskGoal, extra = {}) {
  if (isDryRun()) return runAgent(taskGoal, { cli: guessCli(agentName), cwd: repo, ...extra })
  const a = resolveAgent(agentName, agents, { providers })
  return a.run(taskGoal, { cwd: repo, ...a.opts, ...extra })
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

${failureOutput}

sprint：见 sprint-${idx}-contract.md
contract（验收点以此为准）：
${read(`sprint-${idx}-contract.md`) ?? ''}

修复要求：
- 不要重新设计，只针对失败点修
- 修完后自评一遍，确认这条门能过
- 如果失败是 upstream API/crate 用错（缺字段、变体名错、untagged enum 形状错），
  务必读 cargo registry 里的 crate 源码（路径见 ~/.cargo/registry/src/）确认真实形状，
  不要凭印象写——这是最常见的失败模式`,
    )
    // 返回 true 表示「已应用修复」；runGate 会重跑 gate 命令验证。
    return true
  }
}

async function structured(agentName, taskGoal, schema) {
  if (isDryRun()) return dryRunStruct(taskGoal, schema)
  const a = resolveAgent(agentName, agents, { providers })
  return runStructured(
    (p) => a.run(p, { cwd: repo, ...a.opts }),
    taskGoal,
    { schema, retries: 2 },
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
await main()

async function main() {
  // ── Phase 1: Planner ──
  const spec = await cp.step('plan', async () => {
    const prompt = `你是 Planner。把下面简短需求扩展成完整产品 spec：
- 关注产品上下文与高层技术设计，不要写太细的实现（怕错 cascade）
- 适当 ambitious，scope 可以比用户字面要求更大
- 适当 weave AI features 进产品
- 拆成 ${maxSprints} 个以内的 sprint，每个 sprint 一组用户故事

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
  for (let i = 0; i < spec.sprints.length && i < maxSprints; i++) {
    const sprint = spec.sprints[i]
    const tag = `sprint-${i + 1}-${sprint.name.replace(/\s+/g, '_').slice(0, 30)}`

    await cp.step(tag, () => runSprint(sprint, i + 1))
  }

  cp.done({ sprints: spec.sprints.length, maxRounds })
  await notify(`pge 完成：${spec.title}（${spec.sprints.length} sprints）`)
  console.log(`\n✓ pge 完成。产物在 ${workdir}`)
}

// ── 单个 sprint 的 plan-contract-build-eval-repair 闭环 ──
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
  let review = await structured(
    EVALUATOR,
    `你是 Evaluator（skeptical QA）。评审这份 sprint contract：
- 范围对不对？验收点够不够具体？有没有遗漏 spec 要求？
- 不满意就 agreed=false 并写明修改建议
- 满意才 agreed=true

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
- 实现完成后自评一遍，确保覆盖所有 criteria
- 改动提交到 git（如果可用）

## 卫生铁律（违反即视为失败）
- **新模块必须注册**：创建 src/<mod>/ 必须同时加 src/<mod>/mod.rs 且在 src/lib.rs 里
  \`pub mod <mod>;\`——否则 cargo 根本不编译，等于死代码、测试也跑不到。
- **禁止用 cargo run / cargo build 创建临时探查二进制**（如 *_check / *_explore）。
  要探查 crate 类型用 \`cargo expand\` 或写到 \`#[cfg(test)] mod tests\` 里。
  worktree git status 必须干净，不允许遗留可执行文件。
- **涉及外部 crate / spec 时必须先读源码确认 API 形状**：
  - crate 的真实定义在 \`~/.cargo/registry/src/*/crate-name-*/src/\` 下
  - 不许凭印象写 struct 字段、enum 变体名、untagged enum discriminator
  - 写 serde 测试时，JSON 字面量字段名/必填字段必须按真实 schema 来
- **Cargo.toml 新依赖按项目惯例**：参考已有 optional 依赖（如 \`agui-protocol = { ..., optional = true }\`），
  仅在协议地基（被所有后续模块依赖的纯数据层）时才用非 optional，且要在 spec 里说明。

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
      // 注意：gates 不传给 loop——quality-gate.js 的 resume-fix 路径只允许 1 次重试，
      // 失败仍抛错，和 pge 的多轮 repair loop 模型不兼容。这里在 isDone 里自己跑门，
      // 失败时把 stdout 写进 sprint-<idx>-bugs.md，return false 让 pge loop 进下一轮。
      isDone: async ({ turn }) => {
        if (turn === 0 && maxRounds === 0) return true // 仅跑 build，不验收（异常配置兜底）
        // build 完一轮后才开始验收（turn 0 是 build，turn 1 开始才 eval）
        if (turn === 0) return false

        // ── 1. 质量门（cargo test / clippy / fmt / e2e / tui-mutants …）──
        // 失败的 stdout 写进 bugs.md 供下一轮 generator 修，不抛错。
        try {
          const gates = await sprintGates()
          if (gates.length) {
            await runGates(gates) // 任一门 fail → throw GateError
          }
        } catch (e) {
          const gateName = e.gate ?? 'unknown'
          console.log(`  [gate-fail] ${gateName}: ${e.message}`)
          write(
            `sprint-${idx}-bugs.md`,
            `Quality gate "${gateName}" failed (exit ${e.exitCode ?? 'n/a'}):\n\n` +
            '```\n' + (e.output ?? e.message ?? '').slice(0, 4000) + '\n```\n',
          )
          return false // 让 loop 进下一轮 generator 修
        }

        // ── 2. Evaluator 按 contract 验收 ──
        // 包 try/catch：evaluator 模型偶尔会输出非 JSON（把推理过程也吐出来），
        // runStructured 重试 3 次仍失败时抛错——这里捕获后当作「evaluator 自己
        // 出问题」处理：写 bugs.md 让下一轮 generator 看到，return false 继续
        // repair loop。不让整个 flow 因 evaluator 输出格式问题崩溃。
        let verdict
        try {
          verdict = await structured(
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
          )
        } catch (e) {
          console.log(`  [evaluator-fail] ${e.message?.slice(0, 200) ?? e}`)
          write(
            `sprint-${idx}-bugs.md`,
            `Evaluator 跑结构化输出失败（3 次重试仍非合法 JSON）。` +
            `这通常是 evaluator 模型自身的输出格式问题，不一定是代码错。\n\n` +
            `请 generator 重新自评一遍 contract 各验收点，确认实现无误；` +
            `下一轮 evaluator 会重试。\n\n错误：${e.message ?? e}\n`,
          )
          return false
        }

        write(`sprint-${idx}-verdict.json`, JSON.stringify(verdict, null, 2))

        const fails = verdict.findings.filter(f => f.status === 'fail')
        if (verdict.overall === 'pass' || fails.length === 0) {
          write(`sprint-${idx}-bugs.md`, '') // 清空 bug list
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
    console.log(`  [warn] sprint ${idx} 未在 ${maxRounds} 轮内通过验收，最终 verdict: ${JSON.parse(finalVerdict).overall}`)
  }
}

// 加载质量门：业务项目 .flowcast/gates.json + 内置默认（合并）
async function sprintGates() {
  let builtin = []
  let project = []
  try { builtin = defaultGates() } catch { /* 无内置也无所谓 */ }
  try { project = await loadGates({ repo }) } catch { /* 业务项目没声明也无所谓 */ }
  return mergeGates(builtin, project)
}

function defaultGates() {
  // 默认不强制任何门——业务项目通过 .flowcast/gates.json 声明自己的 lint/test/build。
  return []
}
