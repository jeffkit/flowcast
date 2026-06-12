#!/usr/bin/env node
/**
 * force-dev flow — FORCE Lab 标准开发工作流
 *
 * 用法：
 *   node flows/force-dev.js --run-id <id> --feature <name> [--repo <path>]
 *   node flows/force-dev.js --run-id <id>          # 断点续跑，不需要重传参数
 *   node flows/force-dev.js --list                 # 列出所有 run
 *
 * 批量模式（由 todo-drain 调用）：
 *   --prompt-file <path>   从文件读取已有 feature 描述，跳过 HITL 确认
 *
 * Phase 1B（需求澄清）在脚本外完成，用户确认后传入 --feature 启动脚本。
 */

import { parseArgs } from 'util'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { Checkpoint } from '../checkpoint.js'
import { runAgent, runAgentChain, parallel, waitForInput, setWorkdir } from '../agent.js'
import { runGates } from '../quality-gate.js'
import { loadProviders, resolveProvider } from '../provider.js'

// ── CLI 参数解析 ─────────────────────────────────────────────────
const { values: opts } = parseArgs({
  options: {
    'run-id':     { type: 'string' },
    feature:      { type: 'string' },
    repo:         { type: 'string', default: process.cwd() },
    list:         { type: 'boolean', default: false },
    model:        { type: 'string' },               // 可选，不传则用各 CLI 自身默认模型
    reviewer:     { type: 'string', default: 'claude' },  // 审查用哪个 CLI
    'prompt-file': { type: 'string' },              // 批量模式：从文件读取 feature 描述，跳过 HITL
  }
})

if (opts.list) {
  listRuns()
  process.exit(0)
}

const runId = opts['run-id'] ?? `run-${Date.now()}`
const repo  = opts.repo

// 批量模式：从 --prompt-file 读取已有 feature 描述（todo-drain 写入的文件）
// promptFileContent 非空时跳过 HITL 确认，直接写入 prompt.md
const promptFileContent = opts['prompt-file'] && existsSync(opts['prompt-file'])
  ? readFileSync(opts['prompt-file'], 'utf8')
  : null
const batchMode = !!promptFileContent

// ── 主流程 ───────────────────────────────────────────────────────
const cp = new Checkpoint(runId, `${repo}/.flowx/runs`)

// provider：把「用哪个网关/模型/密钥」从代码抽到 .flowx/providers.*（密钥用 ${VAR} 运行时插值）。
const projectCfg = loadProjectConfig(repo)
const defaultAgentCfg = projectCfg?.agents?.default ?? {}
const reviewerCfg = projectCfg?.agents?.reviewer ?? null
const providers = await loadProviders({ repo })

// provider 可写成单个名字或数组（数组 = 主 + 回退；claude adapter 内部按序回退）
function resolveProviderChain(spec) {
  if (!spec) return { primary: null, fallbacks: [] }
  const names = Array.isArray(spec) ? spec : [spec]
  const bundles = names.map(n => resolveProvider(n, providers))
  return { primary: bundles[0] ?? null, fallbacks: bundles.slice(1) }
}

// 把单个 agent spec（{cli,provider,model,timeout,extraArgs}）解析成一份 runAgent opts。
// 缺 extraArgs（如 claude 的 --dangerously-skip-permissions）会让非交互模式下写文件/git/构建因权限被拒而失败；
// 缺 timeout 会回退到 adapter 默认 5min，对要跑 build/test 的里程碑极易超时。
function buildOpts(spec = {}) {
  const { primary, fallbacks } = resolveProviderChain(spec.provider)
  // model 优先级：CLI --model > provider.model > spec.model > 无（CLI 自身默认）
  const model = opts.model ?? primary?.model ?? spec.model
  return {
    ...(spec.cli ? { cli: spec.cli } : {}),
    ...(model ? { model } : {}),
    ...(primary ? { provider: primary } : {}),
    ...(fallbacks.length ? { providerFallbacks: fallbacks } : {}),
    ...(spec.timeout ? { timeout: spec.timeout } : {}),
    ...(Array.isArray(spec.extraArgs) ? { extraArgs: spec.extraArgs } : {}),
  }
}

// agent 配置可写成单对象或数组：数组 = 跨 CLI 回退链（前者限额/不可用 → 下一个，
// 如 claude+minimax → agy → claude+deepseek）。fallbackCli：spec 没写 cli 时的兜底。
function resolveChain(cfg, fallbackCli) {
  const specs = Array.isArray(cfg) ? cfg : [cfg ?? {}]
  return specs.map(s => buildOpts(fallbackCli && !s.cli ? { ...s, cli: fallbackCli } : s))
}

const chainLabel = chain => chain.map(o => `${o.cli ?? 'claude'}${o.provider ? '/' + o.provider.name : ''}`).join(' → ')

const defaultChain = resolveChain(defaultAgentCfg)
// reviewer：无专门配置时复用 default 链；spec 缺 cli 时用 --reviewer flag 兜底。
const reviewerChain = reviewerCfg ? resolveChain(reviewerCfg, opts.reviewer) : defaultChain
// reviewer 提示词前缀取首个 reviewer spec。
const reviewerSpec0 = Array.isArray(reviewerCfg) ? reviewerCfg[0] : reviewerCfg
const reviewPromptPrefix = reviewerSpec0?.extraPromptPrefix ? reviewerSpec0.extraPromptPrefix + '\n\n' : ''

console.log(`  agent chain: ${chainLabel(defaultChain)}`)
if (reviewerCfg) console.log(`  reviewer chain: ${chainLabel(reviewerChain)}`)

// 续跑时从 state 里恢复参数，首次运行时从 CLI 取
const feature = opts.feature ?? cp.getPauseContext().feature
if (!feature) {
  console.error('缺少 --feature 参数')
  process.exit(1)
}

// 全局绑定工作目录，后续所有 runAgent 调用自动继承
setWorkdir(repo)

console.log(`\n▶ force-dev  run=${runId}  feature=${feature}  repo=${repo}  status=${cp.status}\n`)

await run()

// ── Phase 实现 ───────────────────────────────────────────────────

async function run() {
  // ── Phase 1C: 建分支 ──────────────────────────────────────────
  const branch = await cp.step('p1.create-branch', () =>
    runAgentChain(
      `在 ${repo} 创建特性分支 feat/${feature}，切换到该分支，只返回分支名，不要其他内容。`,
      defaultChain
    )
  )
  console.log(`  branch: ${branch?.trim()}`)

  // ── Phase 1D: 写 prompt.md ────────────────────────────────────
  const planDir = `${repo}/docs/exec-plans/active/${feature}`
  await cp.step('p1.write-prompt', async () => {
    if (batchMode) {
      // 批量模式：直接写入已准备好的内容，跳过 agent 生成
      mkdirSync(planDir, { recursive: true })
      writeFileSync(`${planDir}/prompt.md`, promptFileContent)
      return 'done'
    }
    return runAgentChain(
      `在 ${planDir}/ 目录创建 prompt.md。
       内容包含三个部分：目标（用户视角描述）、完成标准（每条可验证）、非目标（至少一条）。
       feature: ${feature}
       写完文件后只回复 "done"。`,
      defaultChain
    )
  })

  // ── HITL Gate: 用户确认 prompt.md（批量模式跳过）────────────
  const promptApproved = await cp.step('p1.prompt-approval', async () => {
    if (batchMode) return true  // 批量模式 auto-approve
    const answer = await waitForInput(
      `prompt.md 已生成，请查看 ${planDir}/prompt.md\n确认继续？(y/n)`
    )
    return answer === 'y'
  })

  if (!promptApproved) {
    cp.pause('用户未确认 prompt.md', { feature, branch })
  }

  // ── Phase 2: 写 plan.md，再单独读取里程碑结构 ─────────────────
  await cp.step('p2.write-plan', () =>
    runAgentChain(
      `读取 ${repo}/docs/exec-plans/active/${feature}/prompt.md，
       在同目录创建 plan.md，包含：里程碑列表（每个有验证命令）、E2E checkpoint 标记。
       写完后只回复 "done"。`,
      defaultChain
    )
  )

  // 单独一步提取里程碑结构，要求严格 JSON 输出
  const milestonesJson = await cp.step('p2.parse-milestones', () =>
    runAgentChain(
      `读取 ${repo}/docs/exec-plans/active/${feature}/plan.md，
       提取所有里程碑，只返回如下 JSON，不要有任何其他文字：
       {"milestones":[{"id":"m1","name":"里程碑名称","e2e":false}]}
       e2e 字段：该里程碑有 E2E checkpoint 标记则为 true，否则为 false。`,
      defaultChain
    )
  )

  let milestones
  try {
    // 从返回文本里提取 JSON（防止 claude 在前后多输出文字）
    const match = milestonesJson?.match(/\{[\s\S]*\}/)
    milestones = match ? JSON.parse(match[0]).milestones : null
    if (!Array.isArray(milestones) || milestones.length === 0) throw new Error('empty')
  } catch {
    milestones = [{ id: 'm1', name: 'main', e2e: false }]
  }
  console.log(`  milestones: ${milestones.map(m => m.id).join(', ')}`)

  // ── Phase 3: 里程碑循环 ───────────────────────────────────────
  for (const m of milestones) {
    await executeMilestone(m, feature, repo, branch)
  }

  // ── Phase 3.5: 最终质量门（框架级兜底）─────────────────────────
  // 里程碑级 E2E 仅在 plan.md 标了 checkpoint 时跑，批量模式 plan 常无标记。
  // 这里在归档前强制跑一次 qualityGates，确保红灯不会被归档/开 PR。
  await cp.step('p3.final-gate', async () => {
    const gates = loadQualityGates(repo)
    if (gates.length === 0) {
      console.log('  无 qualityGates 配置，跳过最终质量门')
      return 'SKIP'
    }
    await runGates(gates.map(g => ({ ...g, cwd: repo })))
    return 'GATE:PASS'
  })

  // ── Phase 4: 归档 + PR ────────────────────────────────────────
  await cp.step('p4.archive', () =>
    runAgentChain(
      `执行以下步骤，工作目录 ${repo}：
       1. git mv docs/exec-plans/active/${feature} docs/exec-plans/completed/${feature}
       2. git commit -m "docs: archive exec-plan for ${feature}"
       3. git push -u origin ${branch}
       完成后只回复 "done"。`,
      defaultChain
    )
  )

  await cp.step('p4.pr', () =>
    runAgentChain(
      `在 ${repo} 用 gh pr create 创建 PR：
       title: feat: ${feature}
       body: 描述 what/why/how-to-test
       完成后只返回 PR URL。`,
      defaultChain
    )
  )

  await cp.step('p4.journal', () =>
    runAgentChain(
      `在 ${repo}/journal/ 目录（不存在则创建）写今天的 journal 条目，
       记录 feature=${feature} 的完成情况，格式参考目录内已有文件。
       完成后只回复 "done"。`,
      defaultChain
    )
  )

  cp.done({ feature, branch })
  console.log(`\n✓ force-dev 完成  feature=${feature}`)
}

async function executeMilestone(m, feature, repo, branch) {
  const base = `p3.${m.id}`
  const planDir = `${repo}/docs/exec-plans/active/${feature}`

  // 实现
  const gates = loadQualityGates(repo)
  const gateHint = gates.length > 0
    ? `验证命令（必须全绿）：\n${gates.map(g => `  - ${g.name}: ${g.cmd}`).join('\n')}`
    : '运行 lint+typecheck+test+build'
  await cp.step(`${base}.implement`, () =>
    runAgentChain(
      `读取 ${planDir}/plan.md，执行里程碑 ${m.id}（${m.name}）：
       写代码、写测试、${gateHint}、
       在 ${planDir}/reviews/${m.id}/ 目录（不存在则创建）写 review-request.yaml、
       更新 ${planDir}/implement.md、git commit。
       完成后最后一行只输出 IMPL:DONE。`,
      defaultChain
    )
  )

  // 审查：reviewerChain（可跨 CLI 回退）在模块顶部已解析；reviewPromptPrefix 取首个 reviewer spec。
  const reviewVerdict = await cp.step(`${base}.review`, () =>
    runAgentChain(
      `${reviewPromptPrefix}读取 ${planDir}/reviews/${m.id}/review-request.yaml 和相关代码，
       执行对抗性审查，把结果写入 ${planDir}/reviews/${m.id}/review-findings.yaml。
       最后一行只输出 VERDICT:PASS 或 VERDICT:NEEDS_FIX，不要其他内容。`,
      reviewerChain
    )
  )

  // 修复循环（最多 3 轮）
  if (reviewVerdict?.includes('NEEDS_FIX')) {
    await fixLoop(m, base, planDir, repo)
  }

  // E2E / 质量门（如果标记了 checkpoint）
  if (m.e2e) {
    await cp.step(`${base}.e2e`, async () => {
      const gates = loadQualityGates(repo)
      if (gates.length > 0) {
        // 有项目级质量门配置（如 Rust 的 cargo test/clippy），直接跑
        await runGates(gates.map(g => ({ ...g, cwd: repo })))
        return 'E2E:PASS'
      }
      // 无配置则回退到 argusai（FORCE Lab 标准 E2E）
      return runAgentChain(
        `在 ${repo} 跑 E2E 验证里程碑 ${m.id}：
         argusai status → argusai dev/rebuild → argusai run。
         最后一行只输出 E2E:PASS 或 E2E:FAIL:原因。`,
        defaultChain
      )
    })
  }
}

/** 读取项目 .flowx/config.json，不存在或解析失败返回 null。 */
function loadProjectConfig(repoPath) {
  const cfgPath = join(repoPath, '.flowx', 'config.json')
  if (!existsSync(cfgPath)) return null
  try { return JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { return null }
}

/**
 * 读取项目 .flowx/config.json 里的质量门配置。
 * 不存在时返回空数组，由调用方决定 fallback。
 */
function loadQualityGates(repoPath) {
  const cfg = loadProjectConfig(repoPath)
  return Array.isArray(cfg?.qualityGates) ? cfg.qualityGates : []
}

async function fixLoop(m, base, planDir, repo) {
  for (let i = 1; i <= 3; i++) {
    const fixKey = `${base}.fix-${i}`
    if (cp.state.completed[fixKey] === 'PASS') break

    await cp.step(fixKey, () =>
      runAgentChain(
        `读取 ${planDir}/reviews/${m.id}/review-findings.yaml，
         修复所有 CRITICAL 和 HIGH 问题，补充对抗性测试，
         重跑 lint+test+build，更新 review-findings.yaml，git commit。
         最后一行只输出 VERDICT:PASS 或 VERDICT:NEEDS_FIX，不要其他内容。`,
        defaultChain
      )
    )

    const verdict = cp.state.completed[fixKey]
    if (verdict?.includes('PASS')) break
    if (i === 3) {
      console.warn(`\n⚠ ${m.id} 超过 3 轮未通过审查，需要人工介入`)
      cp.pause(`${m.id} review escalated`, { milestone: m.id })
    }
  }
}

// ── 列出所有 run ─────────────────────────────────────────────────
function listRuns() {
  const dir = join(opts.repo, '.flowx/runs')
  if (!existsSync(dir)) { console.log('无历史 run'); return }
  readdirSync(dir).forEach(id => {
    try {
      const s = JSON.parse(readFileSync(join(dir, id, 'state.json'), 'utf8'))
      console.log(`${id}  status=${s.status}  feature=${s.pauseContext?.feature ?? '?'}  step=${s.currentStep ?? s.status}`)
    } catch { /* 损坏的 state，跳过 */ }
  })
}
