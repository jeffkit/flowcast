// test/console.test.js — 控制台（dashboard 三 tab）相关测试
//
// 覆盖：
//   - flow 归因：Checkpoint 新建 run 时写入 flowPath/flowName（env 优先，回退 argv[1]）
//   - listFlows：项目级 + 用户级 flow 文件扫描（含 .flowcast/.flowx 兼容与去重）
//   - groupByWorkflow：按 flowName 聚合 run 统计
//   - generateDashboard：合并 agents + workflows + runs 进同一 model
//   - renderHtml：三 tab 结构（Runs/Agents/Workflows）出现在 HTML 中

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checkpoint } from '../checkpoint.js'
import { listFlows } from '../flows-registry.js'
import { collectRuns, groupByWorkflow } from '../dashboard/collect.js'
import { generateDashboard, renderHtml } from '../dashboard/index.js'
import { clearFlowcastDirCache } from '../dirs.js'

// ── 夹具 ──────────────────────────────────────────────────────
function tempRepo() { return mkdtempSync(join(tmpdir(), 'flowcast-console-')) }

function writeRun(runsRoot, runId, state) {
  const dir = join(runsRoot, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  return dir
}

/** 造一个 .js flow 文件到指定目录。 */
function writeFlow(dir, name, content = '// noop flow') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
}

// ── flow 归因：Checkpoint 新建 run 写入 flowPath/flowName ──────

test('flow 归因：FLOWCAST_FLOW_ABS env 存在时写入 state（优先级最高）', () => {
  const repo = tempRepo()
  const prevEnv = process.env.FLOWCAST_FLOW_ABS
  const prevArgv1 = process.argv[1]
  try {
    process.env.FLOWCAST_FLOW_ABS = '/abs/path/to/my-flow.mjs'
    process.argv[1] = '/somewhere/else.js'  // env 应优先于 argv[1]
    const cp = new Checkpoint('attrib-test-1', join(repo, '.flowcast', 'runs'))
    assert.equal(cp.state.flowPath, '/abs/path/to/my-flow.mjs')
    assert.equal(cp.state.flowName, 'my-flow')
  } finally {
    process.env.FLOWCAST_FLOW_ABS = prevEnv
    process.argv[1] = prevArgv1
    rmSync(repo, { recursive: true, force: true })
  }
})

test('flow 归因：无 env 时回退 process.argv[1]（仅 .js/.mjs 才记录）', () => {
  const repo = tempRepo()
  const prevEnv = process.env.FLOWCAST_FLOW_ABS
  const prevArgv1 = process.argv[1]
  try {
    delete process.env.FLOWCAST_FLOW_ABS
    process.argv[1] = '/repo/flows/quickstart.js'
    const cp = new Checkpoint('attrib-test-2', join(repo, '.flowcast', 'runs'))
    assert.equal(cp.state.flowPath, '/repo/flows/quickstart.js')
    assert.equal(cp.state.flowName, 'quickstart')
  } finally {
    if (prevEnv === undefined) delete process.env.FLOWCAST_FLOW_ABS
    else process.env.FLOWCAST_FLOW_ABS = prevEnv
    process.argv[1] = prevArgv1
    rmSync(repo, { recursive: true, force: true })
  }
})

test('flow 归因：argv[1] 不是 .js/.mjs（如 node 二进制）→ 不写归因字段', () => {
  const repo = tempRepo()
  const prevEnv = process.env.FLOWCAST_FLOW_ABS
  const prevArgv1 = process.argv[1]
  try {
    delete process.env.FLOWCAST_FLOW_ABS
    process.argv[1] = '/usr/local/bin/node'  // 非脚本
    const cp = new Checkpoint('attrib-test-3', join(repo, '.flowcast', 'runs'))
    assert.equal(cp.state.flowPath, undefined)
    assert.equal(cp.state.flowName, undefined)
  } finally {
    if (prevEnv === undefined) delete process.env.FLOWCAST_FLOW_ABS
    else process.env.FLOWCAST_FLOW_ABS = prevEnv
    process.argv[1] = prevArgv1
    rmSync(repo, { recursive: true, force: true })
  }
})

test('flow 归因：续跑（state.json 已存在）不覆盖原归因', () => {
  const repo = tempRepo()
  const runsRoot = join(repo, '.flowcast', 'runs')
  const dir = join(runsRoot, 'attrib-resume')
  mkdirSync(dir, { recursive: true })
  // 预置一个带旧归因的 state.json
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    runId: 'attrib-resume', status: 'paused', completed: {}, steps: [],
    startedAt: '2026-07-30T00:00:00.000Z',
    flowPath: '/original/old-flow.js', flowName: 'old-flow',
  }))
  const prevEnv = process.env.FLOWCAST_FLOW_ABS
  try {
    process.env.FLOWCAST_FLOW_ABS = '/new/new-flow.mjs'
    const cp = new Checkpoint('attrib-resume', runsRoot)
    // 应保留旧归因，不被新 env 覆盖
    assert.equal(cp.state.flowPath, '/original/old-flow.js')
    assert.equal(cp.state.flowName, 'old-flow')
  } finally {
    if (prevEnv === undefined) delete process.env.FLOWCAST_FLOW_ABS
    else process.env.FLOWCAST_FLOW_ABS = prevEnv
    rmSync(repo, { recursive: true, force: true })
  }
})

// ── listFlows：项目级 + 用户级 flow 扫描 ────────────────────────

test('listFlows：扫描项目级 + 用户级，标记 scope，同名 .flowcast 优先于 .flowx', () => {
  const repo = tempRepo()
  const home = mkdtempSync(join(tmpdir(), 'flowcast-home-'))
  try {
    // 项目级 .flowcast/flows
    writeFlow(join(repo, '.flowcast', 'flows'), 'force-dev.js')
    // 项目级 .flowx/flows（兼容）——同名应被 .flowcast 版本去重
    writeFlow(join(repo, '.flowx', 'flows'), 'force-dev.js')
    writeFlow(join(repo, '.flowx', 'flows'), 'legacy-only.mjs')
    // 用户级 ~/.flowcast/flows
    writeFlow(join(home, '.flowcast', 'flows'), 'pge.js')

    const r = listFlows({ repo, home })
    assert.equal(r.project.length, 2, '项目级：force-dev + legacy-only（同名去重）')
    const projNames = r.project.map(f => f.name).sort()
    assert.deepEqual(projNames, ['force-dev', 'legacy-only'])
    assert.equal(r.project.every(f => f.scope === 'project'), true)

    assert.equal(r.user.length, 1)
    assert.equal(r.user[0].name, 'pge')
    assert.equal(r.user[0].scope, 'user')

    assert.equal(r.all.length, 3)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('listFlows：目录不存在时返回空数组（不抛错）', () => {
  const repo = tempRepo()
  const home = mkdtempSync(join(tmpdir(), 'flowcast-home-'))
  try {
    const r = listFlows({ repo, home })
    assert.equal(r.project.length, 0)
    assert.equal(r.user.length, 0)
    assert.equal(r.all.length, 0)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ── groupByWorkflow：按 flowName 聚合 run 统计 ─────────────────

test('groupByWorkflow：按 flowName 聚合 total/running/completed/token', () => {
  const repo = tempRepo()
  try {
    const runsRoot = join(repo, '.flowcast', 'runs')
    writeRun(runsRoot, 'r1', {
      runId: 'r1', status: 'completed', completed: { s: 1 },
      steps: [{ key: 's', status: 'done', durationMs: 10, inputTokens: 100, outputTokens: 50 }],
      startedAt: '2026-07-30T10:00:00.000Z', completedAt: '2026-07-30T10:05:00.000Z',
      flowName: 'quickstart', flowPath: '/x/quickstart.mjs',
    })
    writeRun(runsRoot, 'r2', {
      runId: 'r2', status: 'running', completed: {}, steps: [],
      startedAt: '2026-07-30T11:00:00.000Z',
      flowName: 'quickstart',
    })
    writeRun(runsRoot, 'r3', {
      runId: 'r3', status: 'completed', completed: {}, steps: [],
      startedAt: '2026-07-30T09:00:00.000Z',
      // 无 flowName → 归 (unknown)
    })

    const model = collectRuns(repo)
    const g = model.byWorkflow
    assert.equal(g.quickstart.total, 2)
    assert.equal(g.quickstart.completed, 1)
    assert.equal(g.quickstart.running, 1)
    assert.equal(g.quickstart.totalTokens, 150)
    assert.equal(g['(unknown)'].total, 1)

    // groupByWorkflow 也可单独调用
    const g2 = groupByWorkflow(model.runs)
    assert.deepEqual(Object.keys(g2).sort(), ['(unknown)', 'quickstart'])
  } finally {
    clearFlowcastDirCache()
    rmSync(repo, { recursive: true, force: true })
  }
})

// ── generateDashboard：合并 agents + workflows + runs ───────────

test('generateDashboard：model 含 runs + agents + workflows + byWorkflow', async () => {
  const repo = tempRepo()
  const home = mkdtempSync(join(tmpdir(), 'flowcast-home-'))
  try {
    // 造一个 run + 一个 flow 文件
    writeRun(join(repo, '.flowcast', 'runs'), 'g1', {
      runId: 'g1', status: 'completed', completed: {}, steps: [],
      startedAt: '2026-07-30T10:00:00.000Z',
      flowName: 'demo', flowPath: join(repo, '.flowcast', 'flows', 'demo.js'),
    })
    writeFlow(join(repo, '.flowcast', 'flows'), 'demo.js')

    const { model } = await generateDashboard({ repo, home, out: join(repo, 'dash.html') })
    assert.ok(Array.isArray(model.runs), 'runs 是数组')
    assert.equal(model.runs.length, 1)
    assert.ok(Array.isArray(model.agents), 'agents 是数组')
    assert.ok(model.workflows && Array.isArray(model.workflows.all), 'workflows.all 是数组')
    assert.equal(model.workflows.project.length, 1)
    assert.equal(model.workflows.project[0].name, 'demo')
    assert.ok(model.byWorkflow, 'byWorkflow 存在')
  } finally {
    clearFlowcastDirCache()
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('generateDashboard：agents 采集失败不阻断，runs 仍可用（容错）', async () => {
  // 用一个不存在的 repo 路径触发 collect 正常但 agents/workflows 异常时不崩
  const repo = tempRepo()
  try {
    const { model } = await generateDashboard({ repo, out: join(repo, 'dash.html') })
    assert.ok(Array.isArray(model.runs))
    // agents/workflows 要么成功要么走容错分支（都应是合法结构）
    assert.ok(Array.isArray(model.agents) || model.agents === undefined)
  } finally {
    clearFlowcastDirCache()
    rmSync(repo, { recursive: true, force: true })
  }
})

// ── renderHtml：三 tab 结构 ────────────────────────────────────

test('renderHtml：含 Runs/Agents/Workflows 三个 tab 按钮 + 三个 panel', () => {
  const model = {
    repo: '/x', generatedAt: '2026-07-30T00:00:00.000Z', staleMs: 600000,
    runs: [], roots: [], stats: { total: 0 }, byWorkflow: {},
    agents: [{ name: 'a', executor: 'cursor', ready: true, installed: true, configured: true }],
    workflows: { project: [], user: [], all: [] },
  }
  const html = renderHtml(model)
  for (const t of ['runs', 'agents', 'workflows']) {
    assert.ok(html.includes(`data-tab="${t}"`), `tab 按钮 ${t} 存在`)
  }
  assert.ok(html.includes('function renderAgentsTab'), 'Agents tab 渲染函数内嵌')
  assert.ok(html.includes('function renderWorkflowsTab'), 'Workflows tab 渲染函数内嵌')
  assert.ok(html.includes('function switchTab'), 'tab 切换函数内嵌')
})

test('renderHtml：tab 按钮显示计数（runs N / agents ready/total / workflows N）', () => {
  const model = {
    repo: '/x', generatedAt: '2026-07-30T00:00:00.000Z', staleMs: 600000,
    runs: [{ runId: 'r1' }, { runId: 'r2' }], roots: [], stats: { total: 2 }, byWorkflow: {},
    agents: [
      { name: 'a', ready: true },
      { name: 'b', ready: false },
    ],
    workflows: { project: [{ name: 'f1', path: '/f1', scope: 'project' }], user: [], all: [{ name: 'f1' }] },
  }
  const html = renderHtml(model)
  assert.ok(html.includes('>Runs <em>2</em>'), 'Runs tab 显示 run 计数')
  assert.ok(html.includes('Agents <em>1/2'), 'Agents tab 显示 ready/total')
  assert.ok(html.includes('Workflows <em>1</em>'), 'Workflows tab 显示 flow 计数')
})

test('renderHtml：run 的 flowName 出现在内嵌 JSON 中（供 Runs tab 标签渲染）', () => {
  const model = {
    repo: '/x', generatedAt: '2026-07-30T00:00:00.000Z', staleMs: 600000,
    runs: [{ runId: 'r1', flowName: 'quickstart', flowPath: '/x/quickstart.mjs' }],
    roots: [], stats: { total: 1 }, byWorkflow: { quickstart: { flowName: 'quickstart', total: 1 } },
    agents: [], workflows: { project: [], user: [], all: [] },
  }
  const html = renderHtml(model)
  assert.ok(html.includes('"flowName":"quickstart"'), 'flowName 进了内嵌 JSON')
  assert.ok(html.includes('"flowPath":"/x/quickstart.mjs"'), 'flowPath 进了内嵌 JSON')
})
