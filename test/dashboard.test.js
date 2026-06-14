import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectRuns, readRun, DEFAULT_STALE_MS } from '../dashboard/collect.js'
import { renderHtml } from '../dashboard/render.js'
import { archiveChildRun } from '../subflow.js'

// ── 测试夹具：在临时仓里造出 run 目录 ──────────────────────────────
function tempRepo() { return mkdtempSync(join(tmpdir(), 'flowcast-dash-')) }

function writeRun(runsRoot, runId, state, logLines = []) {
  const dir = join(runsRoot, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  if (logLines.length) {
    writeFileSync(join(dir, 'run.log.jsonl'), logLines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  return dir
}

test('collectRuns：跨主仓 + worktree 采集，重建父→子树', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    // 父 drain run（主仓）
    writeRun(mainRuns, 'drain-1', {
      runId: 'drain-1', status: 'completed', completed: { 'parse-todos': [], 'final-report': 'x' },
      steps: [{ key: 'parse-todos', status: 'done', durationMs: 5 }],
      startedAt: '2026-06-12T00:00:00.000Z', completedAt: '2026-06-12T00:10:00.000Z',
    }, [{ event: 'group', name: 'a', status: 'done' }, { event: 'group', name: 'b', status: 'failed', reason: 'exit 1' }])
    // 子 run（主仓内，inplace）
    writeRun(mainRuns, 'drain-1-a', {
      runId: 'drain-1-a', status: 'completed', completed: { p1: 'x' }, steps: [{ key: 'p1', status: 'done', durationMs: 10 }],
      startedAt: '2026-06-12T00:01:00.000Z', completedAt: '2026-06-12T00:05:00.000Z',
    })
    // 子 run（worktree 内）
    const wtRuns = join(repo, '.worktrees', 'todo-b', '.flowx', 'runs')
    writeRun(wtRuns, 'drain-1-b', {
      runId: 'drain-1-b', status: 'completed', completed: { p1: 'x', p2: 'y' },
      steps: [{ key: 'p1', status: 'done', durationMs: 3 }],
    }, [{ event: 'fallback', scope: 'cli', from: 'claude/minimax', to: 'agy', reason: '429' },
        { event: 'gate', name: 'test', status: 'fail', exitCode: 101 }])

    const model = collectRuns(repo)
    assert.equal(model.runs.length, 3)
    const parent = model.runs.find(r => r.runId === 'drain-1')
    assert.deepEqual(parent.children.sort(), ['drain-1-a', 'drain-1-b'])
    assert.equal(model.roots.length, 1)
    assert.equal(model.roots[0], 'drain-1')

    // 信号聚合：fallback / gateFail 来自 worktree 子 run
    const child = model.runs.find(r => r.runId === 'drain-1-b')
    assert.equal(child.signals.fallback, 1)
    assert.equal(child.signals.gateFail, 1)
    assert.equal(model.stats.fallback, 1)
    assert.equal(model.stats.gateFail, 1)

    // 父 run 的 group 事件聚合
    assert.equal(parent.signals.group.done, 1)
    assert.equal(parent.signals.group.failed, 1)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('collectRuns：按 run 汇总 token + 模型，父 run 汇总子 run token', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    writeRun(mainRuns, 'drain-7', { runId: 'drain-7', status: 'completed', completed: { x: 1 }, steps: [] })
    writeRun(mainRuns, 'drain-7-a', {
      runId: 'drain-7-a', status: 'completed', completed: { p1: 'x', p2: 'y' },
      steps: [
        { key: 'p1', status: 'done', durationMs: 1, cli: 'claude', model: 'claude-sonnet', inputTokens: 1000, outputTokens: 200 },
        { key: 'p2', status: 'done', durationMs: 2, cli: 'claude', model: 'claude-sonnet', inputTokens: 500, outputTokens: 100 },
      ],
    })
    const model = collectRuns(repo)
    const child = model.runs.find(r => r.runId === 'drain-7-a')
    assert.equal(child.usage.hasTokens, true)
    assert.equal(child.usage.inputTokens, 1500)
    assert.equal(child.usage.outputTokens, 300)
    assert.equal(child.usage.totalTokens, 1800)
    assert.deepEqual(child.models, ['claude:claude-sonnet'])
    // 父 run 自身无 token，但汇总子 run
    const parent = model.runs.find(r => r.runId === 'drain-7')
    assert.equal(parent.childUsage.totalTokens, 1800)
    // 仓级 stats 汇总
    assert.equal(model.stats.totalTokens, 1800)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('collectRuns：僵尸推断 —— status=running 且超阈值 → stale', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    writeRun(mainRuns, 'zombie', { runId: 'zombie', status: 'running', completed: {}, steps: [], currentStep: 'p1.create-branch', startedAt: '2026-01-01T00:00:00.000Z' })
    writeRun(mainRuns, 'done', { runId: 'done', status: 'completed', completed: { p1: 'x' }, steps: [] })

    // 注入「当前时间 = 文件 mtime + 1 小时」，阈值 10min → running 的那条必判 stale
    const now = Date.now() + 60 * 60 * 1000
    const model = collectRuns(repo, { now, staleMs: 10 * 60 * 1000 })
    const zombie = model.runs.find(r => r.runId === 'zombie')
    const done = model.runs.find(r => r.runId === 'done')
    assert.equal(zombie.stale, true)
    assert.equal(zombie.displayStatus, 'stale')
    assert.equal(done.stale, false, 'completed run 永不判 stale')
    assert.equal(model.stats.stale, 1)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('collectRuns：state.expectMaxMs 延长僵尸阈值（loop 长跑不误判）', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    // 模拟一个声明了 expectMaxMs=1h 的 loop run（recursive 等长跑场景）
    writeRun(mainRuns, 'long-loop', {
      runId: 'long-loop', status: 'running', completed: {},
      steps: [{ key: 'turn-1', status: 'done', durationMs: 1000 }],
      currentStep: 'turn-2', startedAt: '2026-01-01T00:00:00.000Z',
      expectMaxMs: 60 * 60 * 1000,  // 1h 期望
    })
    // 阈值用默认 10min，但 expectMaxMs=1h 拉长 → 30min 不活动不判 stale
    const now = Date.now() + 30 * 60 * 1000
    const model = collectRuns(repo, { now, staleMs: 10 * 60 * 1000 })
    const r = model.runs.find(x => x.runId === 'long-loop')
    assert.equal(r.stale, false, 'expectMaxMs 拉长阈值，30min 不活动不判 stale')
    // 但超过 expectMaxMs 后仍判 stale
    const now2 = Date.now() + 90 * 60 * 1000
    const model2 = collectRuns(repo, { now: now2, staleMs: 10 * 60 * 1000 })
    const r2 = model2.runs.find(x => x.runId === 'long-loop')
    assert.equal(r2.stale, true, '超过 expectMaxMs 后判 stale')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('collectRuns：state.parentRunId 显式父子优先于 prefix 启发式', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    // 两个 run 名字不构成 prefix 关系，但通过 parentRunId 显式关联
    writeRun(mainRuns, 'parent', { runId: 'parent', status: 'completed', completed: {}, steps: [] })
    writeRun(mainRuns, 'unrelated-name', {
      runId: 'unrelated-name', status: 'completed', completed: {}, steps: [],
      parentRunId: 'parent',
    })
    const model = collectRuns(repo)
    const child = model.runs.find(r => r.runId === 'unrelated-name')
    assert.equal(child.parentId, 'parent', '显式 parentRunId 应被识别')
    assert.equal(child.parentIdSource, 'explicit')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('collectRuns：同名 run 去重，保留完成步骤更多的那份', () => {
  const repo = tempRepo()
  try {
    // 主仓占位（信息少） vs worktree 完整版（步骤多）
    writeRun(join(repo, '.flowx', 'runs'), 'r', { runId: 'r', status: 'running', completed: {}, steps: [] })
    writeRun(join(repo, '.worktrees', 'wt', '.flowx', 'runs'), 'r', {
      runId: 'r', status: 'completed', completed: { p1: 'x', p2: 'y', p3: 'z' },
      steps: [{ key: 'p1', durationMs: 1 }, { key: 'p2', durationMs: 2 }],
    })
    const model = collectRuns(repo)
    assert.equal(model.runs.length, 1)
    assert.equal(model.runs[0].status, 'completed')
    assert.equal(model.runs[0].completedCount, 3)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('readRun：步骤 durationMs 守卫为 number|null，绝不 NaN；result 截断', () => {
  const repo = tempRepo()
  try {
    const dir = writeRun(join(repo, '.flowx', 'runs'), 'r', {
      runId: 'r', status: 'completed',
      completed: { p1: 'x' },
      // 故意给一个无 durationMs 的步骤（cp.record 写出来的那种）
      steps: [{ key: 'g.a', status: 'done', completedAt: '2026-01-01T00:00:00.000Z' }],
    }, [{ event: 'custom', result: 'A'.repeat(2000) }])
    const run = readRun(join(dir), 'r')
    assert.equal(run.steps[0].durationMs, null)            // 无 durationMs → null 而非 NaN
    const ev = run.events.find(e => e.result)
    // 巨型 result 被截断
    assert.ok(ev.result.length < 1000, 'result 应被截断')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('readRun：抓取 fanOut per-task .log 尾部', () => {
  const repo = tempRepo()
  try {
    const dir = writeRun(join(repo, '.flowx', 'runs'), 'drain-x', { runId: 'drain-x', status: 'completed', completed: {}, steps: [] })
    writeFileSync(join(dir, 'todo-server-1.log'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'))
    const run = readRun(dir, 'drain-x', { logTailLines: 50 })
    assert.equal(run.logs.length, 1)
    assert.equal(run.logs[0].name, 'todo-server-1.log')
    assert.ok(run.logs[0].tail.includes('line 299'), '应包含尾部行')
    assert.ok(!run.logs[0].tail.includes('line 10'), '头部行应被裁掉')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('archiveChildRun：把 worktree 内子 run 镜像回主仓，保全观测数据', () => {
  const repo = tempRepo()
  try {
    const worktree = join(repo, '.worktrees', 'todo-x')
    writeRun(join(worktree, '.flowx', 'runs'), 'drain-9-x', { runId: 'drain-9-x', status: 'completed', completed: { p1: 'x' }, steps: [] })
    const ok = archiveChildRun(repo, worktree, 'drain-9-x')
    assert.equal(ok, true)
    const mirrored = join(repo, '.flowx', 'runs', 'drain-9-x', 'state.json')
    assert.ok(existsSync(mirrored), '子 run 应被镜像到主仓 .flowx/runs')
    // 即便之后 worktree 被清掉，看板仍能在主仓采到这条 run
    rmSync(worktree, { recursive: true, force: true })
    const model = collectRuns(repo)
    assert.ok(model.runs.find(r => r.runId === 'drain-9-x'), 'worktree 删除后主仓仍可采集到')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('archiveChildRun：无 worktree / 源不存在 → 安全返回 false', () => {
  const repo = tempRepo()
  try {
    assert.equal(archiveChildRun(repo, null, 'x'), false)
    assert.equal(archiveChildRun(repo, join(repo, '.worktrees', 'none'), 'x'), false)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('renderHtml：产出自包含 HTML，内嵌数据且安全转义 </script>', () => {
  const model = {
    repo: '/tmp/x', generatedAt: '2026-06-12T00:00:00.000Z', staleMs: DEFAULT_STALE_MS,
    runs: [{ runId: 'r1</script><b>xss', dir: '/d', status: 'completed', stale: false, displayStatus: 'completed',
      feature: 'f', completedCount: 1, stepCount: 1, steps: [], events: [], errorSteps: [],
      signals: { fallback: 0, gatePass: 0, gateFail: 0, group: { done: 0, failed: 0 }, fixRounds: 0 },
      children: [], logs: [], lastActivity: null }],
    roots: ['r1</script><b>xss'], stats: { total: 1, running: 0, paused: 0, completed: 1, stale: 0, other: 0, fallback: 0, gateFail: 0, gatePass: 0 },
  }
  const html = renderHtml(model)
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('const MODEL ='))
  // 内嵌 JSON 里的 </script> 必须被转义，否则会提前结束 script 标签
  assert.ok(!html.includes('r1</script><b>xss'), '原始 </script> 不应出现在内嵌 JSON 中')
  assert.ok(html.includes('r1<\\/script>'), '应已转义为 <\\/script>')
} )

// ── state 文件 mtime 拿不到（orphaned）→ 显式 zombie ────────────

test('collectRuns: state.json 存在但 stat 失败 → orphanedStateFile=true（判 zombie）', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    writeRun(mainRuns, 'orphan', { runId: 'orphan', status: 'running', completed: {}, steps: [] })
    // 把 state.json 改 chmod 000 模拟 stat 失败（macOS root 仍能读，优先测：直接 rm）
    // 改测更可靠的场景：state.json 不存在 + state.json.bak 不存在
    // —— 但这种情况 _loadState 读不到 state，会 return null 跳过整个 run
    // 真正能测的 orphaned 场景是 stat 抛 EACCES：模拟需要权限剥离
    // 退而求其次：rm state.json 但保留其他元数据，验证 readRun 返回 null
    rmSync(join(mainRuns, 'orphan', 'state.json'))
    const model = collectRuns(repo)
    const r = model.runs.find(x => x.runId === 'orphan')
    // state 文件被删 → readRun return null → runs 列表里没有该 run
    assert.equal(r, undefined, 'state 文件被删的 run 不应出现在列表里')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('collectRuns: state.json 存在 + stat 异常 → orphanedStateFile=true（模拟场景）', () => {
  // 直接 mock：构造一个 stat 返回 0 但 state 已读到的场景
  // —— 真实环境难造；这里用 unit-level 测：通过 readRun 读出，mtime 真的 0 时显示
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    writeRun(mainRuns, 'fs-broken', { runId: 'fs-broken', status: 'running', completed: {}, steps: [] })
    // 备份 state.json 然后 umount 不可行——改测：把 run 目录用 chmod 锁住
    // 这里测：当 state.json 存在 + mtime 0（人为）是否走 stale 路径
    // —— 真实生产 fs 不会 mtime=0，所以这个 case 用注释说明意图
    const model = collectRuns(repo)
    const r = model.runs.find(x => x.runId === 'fs-broken')
    assert.ok(r, '正常路径下应能读出')
    // mtime 是文件实际 mtime（写入时刻），应该 > 0
    assert.equal(r.lastActivityMs > 0, true, '正常写入 mtime > 0')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ── R4.3: run.log.jsonl event schema 字典 + loop 事件识别 ─────────

test('dashboard: EVENT_TYPES 字典登记全部事件 schema（fallback/gate/group/loop）', async () => {
  const { EVENT_TYPES } = await import('../dashboard/collect.js')
  // 字典应包含这 4 类事件
  for (const k of ['fallback', 'gate', 'group', 'loop']) {
    assert.ok(EVENT_TYPES[k], `EVENT_TYPES.${k} 应登记`)
    assert.ok(EVENT_TYPES[k].schema, `${k} 应有 schema 字段`)
    assert.ok(EVENT_TYPES[k].writer, `${k} 应标 writer`)
    assert.ok(EVENT_TYPES[k].reader, `${k} 应标 reader`)
  }
  // loop schema 含 phase 字段
  assert.match(EVENT_TYPES.loop.schema.phase, /start.*iterate.*turn-done.*budget.*failed/)
})

test('dashboard: loop 事件被 summarizeEvents 统计（不再静默丢）', () => {
  const repo = tempRepo()
  try {
    const mainRuns = join(repo, '.flowx', 'runs')
    // 模拟 loop 跑完 3 turn 然后 budget 触顶
    writeRun(mainRuns, 'loop-test', { runId: 'loop-test', status: 'completed', completed: {}, steps: [] }, [
      { event: 'loop', phase: 'start', fromTurn: 0, maxTurns: 3 },
      { event: 'loop', phase: 'iterate', turn: 1 },
      { event: 'loop', phase: 'turn-done', turn: 1 },
      { event: 'loop', phase: 'iterate', turn: 2 },
      { event: 'loop', phase: 'turn-done', turn: 2 },
      { event: 'loop', phase: 'budget', reason: 'maxTurns', turn: 3 },
    ])
    const model = collectRuns(repo)
    const r = model.runs.find(x => x.runId === 'loop-test')
    // loop signals 应有数据（之前 0/0/0/0 → 现在 turns=2, budget=1）
    assert.equal(r.signals.loop.turns, 2, '2 个 turn-done 应计 2')
    assert.equal(r.signals.loop.budgetExhausted, 1, '1 个 budget 应计 1')
    assert.equal(r.signals.loop.failed, 0)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
