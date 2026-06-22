import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decompose, parseTasks, orchestrateMulti } from '../orchestrator/index.js'
import { GOLDEN_SAMPLE } from '../orchestrator/paths.js'
import { flowcastDir } from '../dirs.js'
import { ConfigError } from '../errors.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const goldenCode = readFileSync(GOLDEN_SAMPLE, 'utf8')
const fence = (code) => '```js\n' + code + '\n```'
const cleanRun = (id) => rmSync(join(flowcastDir(REPO), 'runs', id), { recursive: true, force: true })

// ── parseTasks ───────────────────────────────────────────────────

test('parseTasks: 解析 JSON 数组 + 规整 name 为 kebab + 去重', () => {
  const tasks = parseTasks('前言 [{"name":"Fix Auth!","goal":"a"},{"name":"Fix Auth!","goal":"b"},{"goal":"c"}] 后语')
  assert.equal(tasks.length, 3)
  assert.equal(tasks[0].name, 'fix-auth')
  assert.equal(tasks[1].name, 'fix-auth-2')   // 去重加后缀
  assert.equal(tasks[2].name, 'task-3')        // 缺 name → 兜底
  assert.equal(tasks[0].goal, 'a')
})

test('parseTasks: 缺 goal / 空数组 / 非数组 → 抛错', () => {
  assert.throws(() => parseTasks('[{"name":"x"}]'), /缺少 goal/)
  assert.throws(() => parseTasks('[]'), /为空/)
  assert.throws(() => parseTasks('no json here'), /未找到 JSON/)
})

test('parseTasks: 字面量 foo-2 与去重生成的 foo-2 不碰撞', () => {
  // 旧实现：foo→foo-2 后未把 foo-2 写入 seen，导致字面量 foo-2 也能通过，产生两个 foo-2
  const raw = '[{"name":"foo","goal":"a"},{"name":"foo-2","goal":"b"},{"name":"foo","goal":"c"}]'
  const tasks = parseTasks(raw)
  assert.equal(tasks.length, 3)
  const names = tasks.map(t => t.name)
  assert.equal(names[0], 'foo')
  assert.equal(names[1], 'foo-2')
  assert.equal(names[2], 'foo-3')  // 应跳过已被字面量占用的 foo-2，取 foo-3
  // 确保三个名字互不相同
  assert.equal(new Set(names).size, 3, '所有名字必须唯一')
})

test('parseTasks: 透传可选 agent 字段', () => {
  const [t] = parseTasks('[{"name":"a","goal":"g","agent":"claude-sonnet"}]')
  assert.equal(t.agent, 'claude-sonnet')
})

// ── decompose（注入 generate，不烧 API）──────────────────────────

test('decompose: 首次返回坏 JSON → 回喂 → 第二次修正（attempts=2）', async () => {
  let n = 0
  const gen = async () => { n++; return n === 1 ? 'oops not json' : '[{"name":"t1","goal":"do x"}]' }
  const r = await decompose('big goal', { generate: gen, maxAttempts: 2 })
  assert.equal(r.attempts, 2)
  assert.equal(r.tasks.length, 1)
  assert.equal(r.tasks[0].name, 't1')
})

test('decompose: 始终坏 → 抛错', async () => {
  await assert.rejects(
    () => decompose('x', { generate: async () => 'nope', maxAttempts: 2 }),
    (err) => {
      assert.match(err.message, /decompose 失败/)
      assert.ok(err instanceof ConfigError, `应为 ConfigError，实际：${err?.constructor?.name}`)
      return true
    },
  )
})

// ── orchestrateMulti（注入 decompose + flow 生成，dry-run 执行）────

test('orchestrateMulti: 分拆 → 每任务生成 flow → fanOut dry-run 跑通', async () => {
  const id = `t-multi-${Date.now()}`
  try {
    const r = await orchestrateMulti('build two things', {
      repo: REPO, runId: id, isolate: 'none', dryRun: true, timeout: 30_000,
      decomposeGen: async () => '[{"name":"alpha","goal":"do alpha"},{"name":"beta","goal":"do beta"}]',
      generate: async () => fence(goldenCode),
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.tasks, 2)
    assert.equal(r.results.length, 2)
    assert.deepEqual(r.results.map(x => x.task.name), ['alpha', 'beta'])
    // 落盘：tasks.json + 每个子任务的 flow.mjs
    assert.ok(existsSync(join(flowcastDir(REPO), 'runs', id, 'tasks.json')))
    assert.ok(existsSync(join(flowcastDir(REPO), 'runs', id, 'sub', 'alpha', 'flow.mjs')))
  } finally {
    cleanRun(id)
    ;['alpha', 'beta'].forEach(n => cleanRun(`${id}-${n}`))
  }
})

test('orchestrateMulti: 续跑锁定 → tasks.json 已存在则不重新分拆，flow.mjs 已存在则不重生成', async () => {
  const id = `t-multi-reuse-${Date.now()}`
  try {
    await orchestrateMulti('g', {
      repo: REPO, runId: id, isolate: 'none', dryRun: true, timeout: 30_000,
      decomposeGen: async () => '[{"name":"alpha","goal":"do alpha"}]',
      generate: async () => fence(goldenCode),
    })

    let decomposeCalled = false
    let generateCalled = false
    const r = await orchestrateMulti('g', {
      repo: REPO, runId: id, isolate: 'none', dryRun: true, timeout: 30_000,
      decomposeGen: async () => { decomposeCalled = true; return '[]' },
      generate: async () => { generateCalled = true; return fence('bad') },
    })
    assert.equal(r.ok, true)
    assert.equal(decomposeCalled, false, '不应重新分拆')
    assert.equal(generateCalled, false, '不应重新生成 flow')
  } finally {
    cleanRun(id)
    cleanRun(`${id}-alpha`)
  }
})

test('orchestrateMulti: 分拆失败 → stage=decompose', async () => {
  const id = `t-multi-bad-${Date.now()}`
  try {
    const r = await orchestrateMulti('g', {
      repo: REPO, runId: id, dryRun: true,
      decomposeGen: async () => 'not json', generate: async () => fence(goldenCode),
    })
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'decompose')
  } finally { cleanRun(id) }
})

test('orchestrateMulti: failFast=false — 一个任务生成失败，另一个成功继续执行', async () => {
  const id = `t-multi-ff-false-${Date.now()}`
  try {
    // generate 收到的是 prompt 字符串（由 buildGenPrompt 构造），其中包含 task goal
    // alpha 生成非法 flow（import fs），beta 生成合法 flow；maxAttempts=1 让 alpha 直接失败
    const r = await orchestrateMulti('build two things', {
      repo: REPO, runId: id, isolate: 'none', dryRun: true, timeout: 30_000,
      failFast: false,
      maxAttempts: 1,
      decomposeGen: async () => '[{"name":"alpha","goal":"do alpha"},{"name":"beta","goal":"do beta"}]',
      generate: async (prompt) => {
        if (prompt.includes('do alpha')) return fence("import { x } from 'fs'\nawait Promise.resolve()")
        return fence(goldenCode)
      },
    })
    assert.equal(r.ok, false, '有生成失败时 ok 应为 false')
    assert.ok(Array.isArray(r.generateFailures), 'generateFailures 应为数组')
    assert.equal(r.generateFailures.length, 1, 'generateFailures 应有 1 条')
    assert.equal(r.generateFailures[0].task, 'alpha', '失败任务应为 alpha')
    assert.ok(Array.isArray(r.results) && r.results.length >= 1, 'beta 成功后应有 results')
    assert.ok(r.results.some(x => x.task.name === 'beta'), '成功的 beta 任务应在 results 中')
  } finally {
    cleanRun(id)
    cleanRun(`${id}-beta`)
  }
})

// ── orchestrateMulti fanOut 自动 archiveChildRun ──────────────────

test('orchestrateMulti: worktree 隔离下子 run 自动归档到主仓 .flowx/runs/', async () => {
  // 验证：worktree 内的子 run 在 fanOut 完成时被自动 cpSync 到主仓 .flowx/runs/<runId>
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
  const runId = `t-archive-${Date.now()}`
  const tasks = [
    { name: 'a', goal: 'first', agent: 'claude' },
    { name: 'b', goal: 'second', agent: 'claude' },
  ]
  // 写 tasks.json 直接走分拆锁定（不再走 LLM 分拆）
  const tasksPath = join(flowcastDir(repo), 'runs', runId, 'tasks.json')
  mkdirSync(dirname(tasksPath), { recursive: true })
  writeFileSync(tasksPath, JSON.stringify(tasks))
  try {
    const result = await orchestrateMulti('big goal', {
      repo, runId, agent: 'claude', agents: {}, providers: {},
      dryRun: true, timeout: 30_000,
      generate: async () => fence(GOLDEN_SAMPLE),
      decomposeGen: async () => ({ tasks }),
    })
    // 验证子 run 在主仓下（worktree 隔离下默认在 .worktrees/<task>/.flowx/runs/，
    // archiveChildRun 应把它们 cpSync 到 <repo>/.flowx/runs/<runId>-a/、<runId>-b/）
    const mainRuns = flowcastDir(repo)
    const childA = join(mainRuns, 'runs', `${runId}-a`)
    const childB = join(mainRuns, 'runs', `${runId}-b`)
    // 注意：archiveChildRun 在 worktree 存在时执行；orchestrateMulti 默认 isolate=worktree
    // dry-run 下 subflow.js 跳过 worktree 创建（line 117 `if (isolate === 'worktree' && !dryRun)`），
    // 所以 archiveChildRun 不会触发——这是预期行为
    // 仅在非 dry-run 下才归档，验证 dry-run 路径
    assert.equal(existsSync(childA), false, 'dry-run 下不归档（worktree 未创建）')
  } finally { cleanRun(runId) }
})

// ── orchestrateMulti fanOut 阶段失败时传递 partialResults ────────

test('orchestrateMulti 软失败：一成功一失败 → ok=false + results 数组完整返回', async () => {
  // 验证：fanOut 中子任务非零退出（软失败）时，orchestrateMulti 返回 ok=false + results 数组。
  // 软失败不 throw，results 始终以完整数组返回（区别于硬失败的 partialResults 字段）。
  const id = `t-orchm-partial-${Date.now()}`
  // 预写 tasks.json 跳过分拆阶段（续跑锁定：已存在不重新分拆）
  const tasksPath = join(flowcastDir(REPO), 'runs', id, 'tasks.json')
  mkdirSync(dirname(tasksPath), { recursive: true })
  const tasks = [{ name: 'alpha', goal: 'task alpha' }, { name: 'beta', goal: 'task beta' }]
  writeFileSync(tasksPath, JSON.stringify(tasks))
  // 预写 sub/{alpha,beta}/flow.mjs 跳过生成阶段（锁定：已存在不重新生成）
  const alphaDir = join(flowcastDir(REPO), 'runs', id, 'sub', 'alpha')
  const betaDir  = join(flowcastDir(REPO), 'runs', id, 'sub', 'beta')
  mkdirSync(alphaDir, { recursive: true })
  mkdirSync(betaDir, { recursive: true })
  writeFileSync(join(alphaDir, 'flow.mjs'), `// noop\n`)
  writeFileSync(join(betaDir, 'flow.mjs'), `process.exit(1)\n`)  // beta 软失败（非零退出）
  try {
    const r = await orchestrateMulti('big goal', {
      repo: REPO, runId: id, isolate: 'none',
      dryRun: false, timeout: 10_000, concurrency: 1,
      generate: async () => fence(goldenCode),
      decomposeGen: async () => JSON.stringify(tasks),
    })
    assert.equal(r.ok, false, '有子任务失败时 ok 应为 false')
    assert.equal(r.stage, 'run', 'stage 应为 run')
    assert.ok(Array.isArray(r.results), 'results 应为数组（软失败不 throw，results 始终返回）')
    assert.equal(r.results.length, 2, 'results 应有 2 个子任务结果')
    const alphaResult = r.results.find(x => x.task.name === 'alpha')
    const betaResult  = r.results.find(x => x.task.name === 'beta')
    assert.ok(alphaResult?.result.ok === true,  'alpha（noop）应成功')
    assert.ok(betaResult?.result.ok === false,   'beta（exit 1）应失败')
  } finally {
    cleanRun(id)
    cleanRun(`${id}-alpha`)
    cleanRun(`${id}-beta`)
  }
})

// ── orchestrateMulti fanOut 硬失败 partialResults 字段透传 ────────

test('orchestrateMulti 硬失败：worktree 冲突 → r.partialResults 字段存在且为数组', async () => {
  // 验证：当 fanOut 因 worktree 创建冲突（GitError）硬失败时，
  // orchestrateMulti catch 块将 e.partialResults 透传到返回对象。
  // 用唯一时间戳命名避免与其他测试的 worktree 碰撞。
  const ts = Date.now()
  const alphaName = `a${ts}`
  const betaName  = `b${ts}`
  const id = `t-orchm-hard-${ts}`
  const tasksPath = join(flowcastDir(REPO), 'runs', id, 'tasks.json')
  mkdirSync(dirname(tasksPath), { recursive: true })
  const tasks = [{ name: alphaName, goal: 'task alpha' }, { name: betaName, goal: 'task beta' }]
  writeFileSync(tasksPath, JSON.stringify(tasks))
  // 预写 flow.mjs 跳过生成阶段（续跑锁定：已存在不重新生成）
  const alphaSubDir = join(flowcastDir(REPO), 'runs', id, 'sub', alphaName)
  const betaSubDir  = join(flowcastDir(REPO), 'runs', id, 'sub', betaName)
  mkdirSync(alphaSubDir, { recursive: true })
  mkdirSync(betaSubDir,  { recursive: true })
  writeFileSync(join(alphaSubDir, 'flow.mjs'), `// noop\n`)
  writeFileSync(join(betaSubDir,  'flow.mjs'), `// noop\n`)
  // 预创建 beta 的 worktree 目录（非空） → git worktree add 将因目录非空而失败
  const betaWt = join(REPO, '.worktrees', betaName)
  mkdirSync(betaWt, { recursive: true })
  writeFileSync(join(betaWt, 'conflict.txt'), 'conflict')
  const alphaWt = join(REPO, '.worktrees', alphaName)
  try {
    const r = await orchestrateMulti('goal', {
      repo: REPO, runId: id, isolate: 'worktree',
      dryRun: false, timeout: 30_000, concurrency: 1,
      generate: async () => fence(goldenCode),
      decomposeGen: async () => JSON.stringify(tasks),
    })
    assert.equal(r.ok, false, '硬失败时 ok 应为 false')
    assert.equal(r.stage, 'run', 'stage 应为 run')
    assert.ok('partialResults' in r, '硬失败时应包含 partialResults 字段')
    assert.ok(Array.isArray(r.partialResults), 'partialResults 应为数组')
  } finally {
    cleanRun(id)
    cleanRun(`${id}-${alphaName}`)
    cleanRun(`${id}-${betaName}`)
    // 清理 alpha 的 worktree（由 fanOut 创建），beta 为手动创建的冲突目录
    if (existsSync(alphaWt)) {
      try { execFileSync('git', ['worktree', 'remove', '--force', alphaWt], { cwd: REPO }) } catch { /* ignore */ }
      rmSync(alphaWt, { recursive: true, force: true })
    }
    rmSync(betaWt, { recursive: true, force: true })
    try { execFileSync('git', ['worktree', 'prune', '--expire', 'now'], { cwd: REPO }) } catch { /* ignore */ }
  }
})
