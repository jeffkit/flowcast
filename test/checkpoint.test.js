import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Checkpoint, PauseSignal } from '../checkpoint.js'
import { clearFlowcastDirCache, flowcastDir } from '../dirs.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowcast-cp-')) }

test('Checkpoint.record/has: 同步记录已算好的结果，可被 has 命中', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r1', dir)
    assert.equal(cp.has('g.a'), false)
    const v = cp.record('g.a', { success: true, reason: 'ok' })
    assert.deepEqual(v, { success: true, reason: 'ok' })
    assert.equal(cp.has('g.a'), true)
    // 落盘可被新实例读回（续跑语义）
    const cp2 = new Checkpoint('r1', dir)
    assert.equal(cp2.has('g.a'), true)
    assert.deepEqual(cp2.state.completed['g.a'], { success: true, reason: 'ok' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.record: 并发回调按 fan-out 方式写多个 key 都不丢', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r2', dir)
    // 模拟多个子任务并发完成后各自 record（record 同步，不会交错丢写）
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(async (k) => {
      await new Promise(res => setTimeout(res, Math.random() * 10))
      cp.record(`g.${k}`, { success: true })
    }))
    for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(cp.has(`g.${k}`), true)
    // state.json 最终包含全部 5 条
    const onDisk = JSON.parse(readFileSync(join(dir, 'r2', 'state.json'), 'utf8'))
    assert.equal(Object.keys(onDisk.completed).length, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.event：结构化事件追加进 run.log.jsonl（不进 state.json）', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rev', dir)
    cp.event('fallback', { from: 'a', to: 'b', reason: '429' })
    cp.event('gate', { name: 'test', status: 'fail', exitCode: 101 })
    await cp.flushLog()  // 日志写入是异步的，等待落盘后再读
    const lines = readFileSync(join(dir, 'rev', 'run.log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].event, 'fallback')
    assert.equal(lines[0].reason, '429')
    assert.ok(lines[0].ts, '事件应带时间戳')
    assert.equal(lines[1].event, 'gate')
    // 事件不该污染 state.json
    const state = JSON.parse(readFileSync(join(dir, 'rev', 'state.json'), 'utf8'))
    assert.equal(state.steps.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step：自动捕获 agent 结果的 _meta(model/token) 进步骤记录', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rmeta', dir)
    // 模拟 adapter 返回：字符串 + 挂在 String 包装对象上的 _meta
    const agentResult = Object.assign(String('done'), {
      _meta: { cli: 'claude', model: 'claude-sonnet', inputTokens: 1200, outputTokens: 340 },
    })
    await cp.step('p1.impl', async () => agentResult)
    const onDisk = JSON.parse(readFileSync(join(dir, 'rmeta', 'state.json'), 'utf8'))
    const step = onDisk.steps.find(s => s.key === 'p1.impl')
    assert.equal(step.cli, 'claude')
    assert.equal(step.model, 'claude-sonnet')
    assert.equal(step.inputTokens, 1200)
    assert.equal(step.outputTokens, 340)
    // completed 仍是纯字符串（不被 _meta 污染）
    assert.equal(onDisk.completed['p1.impl'], 'done')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint 报告：record 的步骤无 durationMs 时渲染 "-" 而非 "NaNs"', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('rnan', dir)
    cp.record('group.a', { success: true })   // record 不带 durationMs
    cp.done({ done: 1 })
    const report = readFileSync(join(dir, 'rnan', 'report.md'), 'utf8')
    assert.ok(!report.includes('NaN'), '报告不应出现 NaN')
    assert.match(report, /\| group\.a \| done \| - \|/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step 仍跳过已 record 的 key', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r3', dir)
    cp.record('s1', 'pre-done')
    let ran = false
    const out = await cp.step('s1', async () => { ran = true; return 'fresh' })
    assert.equal(ran, false)        // 已记录 → 不再执行
    assert.equal(out, 'pre-done')   // 返回已存结果
    assert.ok(existsSync(join(dir, 'r3', 'state.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: 重入同一 key 抛错（并发双重执行保护）', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-reentry', dir)
    // 第一个 step 还在异步等待中，第二个用相同 key 立刻 step → 应抛错
    let firstStarted = false
    const first = cp.step('s1', async () => {
      firstStarted = true
      await new Promise(res => setTimeout(res, 50))  // 故意挂着
      return 'first'
    })
    // 等第一个开始执行后，立刻并发第二个
    await new Promise(res => setTimeout(res, 5))
    assert.equal(firstStarted, true)
    await assert.rejects(
      () => cp.step('s1', async () => 'second'),
      /in-flight/,
    )
    await first  // 第一个正常完成
    assert.equal(cp.state.completed['s1'], 'first')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: fn 抛错后 _inFlight 清理，同一 key 可重试', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-retry', dir)
    await assert.rejects(
      () => cp.step('s1', async () => { throw new Error('boom') }),
      /boom/,
    )
    // 失败后 inFlight 应已清理，可以重试
    const out = await cp.step('s1', async () => 'recovered')
    assert.equal(out, 'recovered')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── onStep 横切钩子 ───────────────────────────────────────────────

test('onStep: start/done 事件按序触发，携带 key 和 durationMs', async () => {
  const dir = tempDir()
  try {
    const events = []
    const cp = new Checkpoint('hook-done', dir, { onStep: (e) => events.push(e) })
    await cp.step('p1.work', async () => 'result')
    assert.equal(events.length, 2)
    assert.equal(events[0].event, 'start')
    assert.equal(events[0].key, 'p1.work')
    assert.equal(events[1].event, 'done')
    assert.equal(events[1].key, 'p1.work')
    assert.ok(Number.isFinite(events[1].durationMs), 'done 事件应有 durationMs')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: skip 事件在续跑跳过时触发', async () => {
  const dir = tempDir()
  try {
    const cp1 = new Checkpoint('hook-skip', dir)
    await cp1.step('p1', async () => 'cached')

    const events = []
    const cp2 = new Checkpoint('hook-skip', dir, { onStep: (e) => events.push(e) })
    await cp2.step('p1', async () => 'fresh')
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'skip')
    assert.equal(events[0].key, 'p1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: error 事件在步骤失败时触发，携带 error 信息', async () => {
  const dir = tempDir()
  try {
    const events = []
    const cp = new Checkpoint('hook-err', dir, { onStep: (e) => events.push(e) })
    await assert.rejects(() => cp.step('p1', async () => { throw new Error('boom') }))
    const errEvt = events.find(e => e.event === 'error')
    assert.ok(errEvt, 'error 事件应触发')
    assert.equal(errEvt.key, 'p1')
    assert.match(errEvt.error.message, /boom/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: 钩子抛异常不影响主流程', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('hook-safe', dir, { onStep: () => { throw new Error('hook crash') } })
    const result = await cp.step('p1', async () => 'ok')
    assert.equal(result, 'ok')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('onStep: start/skip/error 事件自动写进 run.log.jsonl', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('hook-log', dir)
    await cp.step('p1', async () => 'done')
    await cp.flushLog()  // 等待 cp 的异步日志（start/done）落盘
    // 续跑 skip
    const cp2 = new Checkpoint('hook-log', dir)
    await cp2.step('p1', async () => 'fresh')
    await cp2.flushLog()  // 等待 cp2 的异步日志（skip）落盘

    const lines = readFileSync(join(dir, 'hook-log', 'run.log.jsonl'), 'utf8')
      .trim().split('\n').map(l => JSON.parse(l))
    const statuses = lines.map(l => l.status)
    assert.ok(statuses.includes('start'), 'jsonl 应有 start 条目')
    assert.ok(statuses.includes('done'),  'jsonl 应有 done 条目')
    assert.ok(statuses.includes('skip'),  'jsonl 应有 skip 条目')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: timeout 超时抛错并带 key 信息', async () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-timeout', dir)
    await assert.rejects(
      () => cp.step('slow', async () => new Promise(res => setTimeout(res, 200)), { timeout: 50 }),
      /timed out/,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.step: 续跑时 _meta 从步骤记录里还原', async () => {
  const dir = tempDir()
  try {
    const cp1 = new Checkpoint('r-meta-resume', dir)
    const agentResult = Object.assign(String('output'), {
      _meta: { cli: 'claude', model: 'claude-sonnet', inputTokens: 500, outputTokens: 100 },
    })
    await cp1.step('impl', async () => agentResult)

    const cp2 = new Checkpoint('r-meta-resume', dir)
    const cached = await cp2.step('impl', async () => 'fresh')
    assert.equal(String(cached), 'output')
    assert.equal(cached._meta?.cli, 'claude')
    assert.equal(cached._meta?.model, 'claude-sonnet')
    assert.equal(cached._meta?.inputTokens, 500)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.pause: 抛出 PauseSignal，状态落盘为 paused', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-pause', dir)
    assert.throws(
      () => cp.pause('等待人工审批', { ticket: 'T-123' }),
      (err) => {
        assert.ok(err instanceof PauseSignal, '应抛 PauseSignal')
        assert.equal(err.pauseReason, '等待人工审批')
        assert.deepEqual(err.pauseContext, { ticket: 'T-123' })
        return true
      },
    )
    // 状态落盘
    const saved = JSON.parse(readFileSync(join(dir, 'r-pause', 'state.json'), 'utf8'))
    assert.equal(saved.status, 'paused')
    assert.equal(saved.pauseReason, '等待人工审批')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint._loadState: state.json 损坏 + 残留旧版 .bak → 从 .bak 恢复（升级兼容）', () => {
  // 用户从旧版本（_flush 写 .bak 的版本）升级到新版：
  // state.json 损坏 + 残留 .bak 仍在 → 仍然从 .bak 恢复（向后兼容旧数据）
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-bak', dir)
    cp.record('step1', 'result1')
    const stPath = join(dir, 'r-bak', 'state.json')
    const bakPath = stPath + '.bak'
    // 新版 _flush 不生成 .bak——验证这一点
    assert.equal(existsSync(bakPath), false, '新版 _flush 不应生成 .bak')
    // 损坏 state.json + 手动造一份 .bak 模拟「旧版本残留」
    writeFileSync(stPath, '{ CORRUPTED JSON }')
    writeFileSync(bakPath, JSON.stringify({ runId: 'r-bak', status: 'running', completed: { step0: 'old' }, steps: [], startedAt: 'x' }))
    const cp2 = new Checkpoint('r-bak', dir)
    assert.equal(cp2.has('step0'), true, '从残留 .bak 恢复后应能看到 step0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Checkpoint._loadState: state.json 损坏 + 无 .bak → 警告 + fresh 启动', () => {
  // 新版 _flush 改用 writeFile+renameSync 原子写：不再生成 .bak（rename 后 tmp 已原子接管）。
  // 真正的新版行为：state.json 损坏 + 没有 .bak → 警告 + fresh 启动。
  const dir = tempDir()
  const warns = []
  const origWarn = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try {
    const cp = new Checkpoint('r-fresh', dir)
    cp.record('step1', 'result1')
    const stPath = join(dir, 'r-fresh', 'state.json')
    assert.equal(existsSync(stPath + '.bak'), false, '新版 _flush 不应生成 .bak')
    // 损坏 state.json
    writeFileSync(stPath, '{ CORRUPTED JSON }')
    const cp2 = new Checkpoint('r-fresh', dir)
    assert.ok(warns.some(w => w.includes('corrupted')), '应打出损坏警告')
    // fresh 启动：没有从任何地方恢复，completed 为空
    assert.equal(cp2.has('step1'), false, 'fresh 启动不应有 step1')
  } finally {
    console.warn = origWarn
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Checkpoint._flush: write+rename 原子写，截断时要么旧要么新完整', () => {
  // 验证 flush 用 rename 替换——state.json 永远是合法 JSON（除非中间被外部破坏）。
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-flush', dir)
    cp.record('step1', 'value1')
    const stPath = join(dir, 'r-flush', 'state.json')
    const tmpPath = stPath + '.tmp'
    // flush 完成后 tmp 不应存在（rename 已替换）
    assert.equal(existsSync(tmpPath), false, 'flush 后 tmp 应已被 rename 替换')
    // state.json 应是合法 JSON
    const parsed = JSON.parse(readFileSync(stPath, 'utf8'))
    assert.equal(parsed.completed.step1, 'value1')
    // 再 record 一次，验证连续 flush 不留 tmp
    cp.record('step2', 'value2')
    assert.equal(existsSync(tmpPath), false, '连续 flush 不留 tmp')
    const parsed2 = JSON.parse(readFileSync(stPath, 'utf8'))
    assert.equal(parsed2.completed.step1, 'value1')
    assert.equal(parsed2.completed.step2, 'value2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Checkpoint.step: 循环里重复调用同一 key 触发 warn（但不报错）', async () => {
  const dir = tempDir()
  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const cp = new Checkpoint('r-dupkey', dir)
    await cp.step('task', async () => 'first')
    // 同 key 再次调用（模拟循环里忘加下标），应 warn 并返回缓存值
    const out = await cp.step('task', async () => 'second')
    assert.equal(out, 'first', '应返回缓存值')
    assert.ok(warnings.some(w => w.includes('task') && w.includes('下标')), '应打出 warn 提示')
  } finally {
    console.warn = origWarn
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── loop 协作窄接口 ─────────────────────────────────────────────

test('Checkpoint.setLoopState/getLoopState: 部分更新，未传字段不动', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-loop', dir)
    // 初始：所有 loop 字段都是 undefined
    assert.deepEqual(cp.getLoopState(), { verdict: undefined, status: undefined, turns: undefined, reason: undefined })
    // 部分更新
    cp.setLoopState({ verdict: 'continue', turns: 3 })
    assert.deepEqual(cp.getLoopState(), { verdict: 'continue', status: undefined, turns: 3, reason: undefined })
    // 单独更新 status 不影响 verdict
    cp.setLoopState({ status: 'completed' })
    assert.deepEqual(cp.getLoopState(), { verdict: 'continue', status: 'completed', turns: 3, reason: undefined })
    // 持久化：重新构造 Checkpoint 应能读出
    const cp2 = new Checkpoint('r-loop', dir)
    assert.deepEqual(cp2.getLoopState(), { verdict: 'continue', status: 'completed', turns: 3, reason: undefined })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Checkpoint.countCompletedTurns: 只数 ^turn-N$ 形式的 key', () => {
  const dir = tempDir()
  try {
    const cp = new Checkpoint('r-turns', dir)
    assert.equal(cp.countCompletedTurns(), 0)
    cp.record('turn-1', 'a')
    cp.record('turn-2', 'b')
    cp.record('not-a-turn', 'c')  // 不应被数
    cp.record('turn-abc', 'd')    // 不应被数
    assert.equal(cp.countCompletedTurns(), 2, '只数 ^turn-N$ 形式')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dry-run 下 dirs.js 把 flowcastDir 指向 ~/.flowcast/dryrun/', async () => {
  // dirs.js 在 FLOWCAST_DRY_RUN=1 时把 flowcastDir() 重定向到 dryrun 根。
  // Checkpoint/memory/failure-context/orchestrator 等都通过 flowcastDir 派生路径，
  // 因此它们自动跟随 dry-run 隔离，不需要每个原语单独判断。
  const { flowcastDir } = await import('../dirs.js')
  const origEnv = process.env.FLOWCAST_DRY_RUN
  process.env.FLOWCAST_DRY_RUN = '1'
  clearFlowcastDirCache()
  try {
    const result = flowcastDir('/some/repo')
    assert.ok(
      result.endsWith('/.flowcast/dryrun') || result.endsWith('flowcast-dryrun'),
      `dry-run 下应指向 ~/.flowcast/dryrun 或 tmp，got: ${result}`,
    )
    // 显式 dryRun=false 强制走真盘路径
    const real = flowcastDir('/some/repo', { dryRun: false })
    assert.ok(real.endsWith('.flowx') || real.endsWith('.flowcast'),
      `dryRun=false 应走真盘，got: ${real}`)
  } finally {
    if (origEnv === undefined) delete process.env.FLOWCAST_DRY_RUN
    else process.env.FLOWCAST_DRY_RUN = origEnv
    clearFlowcastDirCache()
  }
})

test('flowcastDir: 缓存 mtime 守护——.flowcast/ 创建后缓存自动切到新目录', () => {
  // 模拟老项目（仅有空 .flowx/，无 run 数据）升级：先走 .flowx/，
  // 然后建 .flowcast/（mtime 变了，且两者都无 runs/），缓存应自动切到 .flowcast/
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-fcdir-'))
  try {
    // 1) 仅有旧 .flowx/（无 runs/）→ legacy 分支选 .flowx
    clearFlowcastDirCache()
    mkdirSync(join(repo, '.flowx'), { recursive: true })
    const p1 = flowcastDir(repo, { dryRun: false })
    assert.equal(p1, join(repo, '.flowx'), '仅有旧 .flowx/ 时应选 .flowx')

    // 2) 建 .flowcast/——mtime 守护应让缓存自动失效；两者都无 runs/ → 切到 .flowcast
    mkdirSync(join(repo, '.flowcast'), { recursive: true })
    // 不调 clearFlowcastDirCache！靠 mtime 守护自动失效
    const p2 = flowcastDir(repo, { dryRun: false })
    assert.equal(p2, join(repo, '.flowcast'), '建 .flowcast/ 后应自动切到 .flowcast')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('flowcastDir: 全新项目（两者皆无）默认选 .flowcast', () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-fcfresh-'))
  try {
    clearFlowcastDirCache()
    assert.equal(flowcastDir(repo, { dryRun: false }), join(repo, '.flowcast'),
      '全新项目应默认 .flowcast（对齐重命名后的品牌/README）')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('flowcastDir: 旧 .flowx/runs 有数据 + 新建空 .flowcast/ → 黏住 .flowx（升级不丢续跑）', () => {
  // 复现「升级时按 README 新建 .flowcast/config.json，导致进行中 run 续跑找不到」的风险：
  // 只要 .flowx/runs 已承载数据而 .flowcast/ 尚无 runs/，就继续用 .flowx，保住断点续跑。
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-sticky-'))
  try {
    clearFlowcastDirCache()
    mkdirSync(join(repo, '.flowx', 'runs'), { recursive: true })  // 旧项目已有 run 数据
    mkdirSync(join(repo, '.flowcast'), { recursive: true })        // 新建配置目录（尚无 runs/）
    assert.equal(flowcastDir(repo, { dryRun: false }), join(repo, '.flowx'),
      '旧 .flowx/runs 有数据而 .flowcast/ 无 runs/ 时应黏住 .flowx')

    // 一旦 .flowcast/runs 也有了数据（已迁移/已跑新 run），则切到 .flowcast
    mkdirSync(join(repo, '.flowcast', 'runs'), { recursive: true })
    clearFlowcastDirCache()
    assert.equal(flowcastDir(repo, { dryRun: false }), join(repo, '.flowcast'),
      '.flowcast/runs 有数据后应切到 .flowcast')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
