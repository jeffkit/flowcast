import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loop } from '../loop.js'
import { recall } from '../memory.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowx-loop-')) }

test('loop：isDone 在第 N 轮返回 true → completed，轮数正确', async () => {
  const dir = tempDir()
  try {
    let calls = 0
    const res = await loop(
      async ({ turn }) => { calls++; return `work-${turn}` },
      {
        goal: 'reach target',
        isDone: ({ turn }) => turn >= 3,
        runId: 'r-complete', stateDir: dir, maxTurns: 10,
      },
    )
    assert.equal(res.status, 'completed')
    assert.equal(res.turns, 3)
    assert.equal(calls, 3)
    assert.equal(res.lastResult, 'work-3')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loop：达不到目标 → maxTurns 触顶 budget_exhausted', async () => {
  const dir = tempDir()
  try {
    const res = await loop(
      async ({ turn }) => `x-${turn}`,
      { goal: 'g', isDone: () => false, runId: 'r-budget', stateDir: dir, maxTurns: 4 },
    )
    assert.equal(res.status, 'budget_exhausted')
    assert.equal(res.turns, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loop：每轮跑质量门，shell true 通过', async () => {
  const dir = tempDir()
  try {
    const res = await loop(
      async () => 'ok',
      {
        goal: 'g',
        isDone: ({ gateResults }) => gateResults.every((g) => g.passed),
        gates: [{ name: 'noop', cmd: 'true' }],
        runId: 'r-gate', stateDir: dir, maxTurns: 3,
      },
    )
    assert.equal(res.status, 'completed')
    assert.equal(res.turns, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loop：质量门红灯（rollback）→ 抛错', async () => {
  const dir = tempDir()
  try {
    await assert.rejects(
      loop(
        async () => 'x',
        {
          goal: 'g', isDone: () => false,
          gates: [{ name: 'fail', cmd: 'false', onFail: 'rollback' }],
          runId: 'r-gatefail', stateDir: dir, maxTurns: 3,
        },
      ),
      /quality gate 'fail' failed/,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loop：dry-run 下质量门自动判过，骨架可跑通', async () => {
  const dir = tempDir()
  const prev = process.env.FLOWX_DRY_RUN
  process.env.FLOWX_DRY_RUN = '1'
  try {
    const res = await loop(
      async () => 'x',
      {
        goal: 'g',
        isDone: ({ gateResults }) => gateResults.every((g) => g.passed),
        gates: [{ name: 'build', cmd: 'this-command-would-fail-for-real' }],
        runId: 'r-dry', stateDir: dir, maxTurns: 2,
      },
    )
    assert.equal(res.status, 'completed')
  } finally {
    if (prev === undefined) delete process.env.FLOWX_DRY_RUN; else process.env.FLOWX_DRY_RUN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loop：崩溃后用同 runId 续跑，不重跑已完成轮', async () => {
  const dir = tempDir()
  try {
    let firstRunCalls = 0
    // 第一次：turn-2 抛错模拟崩溃（turn-1 已落盘）
    await assert.rejects(loop(
      async ({ turn }) => { firstRunCalls++; if (turn === 2) throw new Error('boom'); return `a-${turn}` },
      { goal: 'g', isDone: () => false, runId: 'r-resume', stateDir: dir, maxTurns: 5 },
    ), /boom/)
    assert.equal(firstRunCalls, 2, '第一次跑了 turn-1 + turn-2(抛错)')

    // 第二次：同 runId 续跑，turn-1 应被跳过，从 turn-2 起
    const seen = []
    const res = await loop(
      async ({ turn }) => { seen.push(turn); return `b-${turn}` },
      { goal: 'g', isDone: ({ turn }) => turn >= 3, runId: 'r-resume', stateDir: dir, maxTurns: 5 },
    )
    assert.equal(res.status, 'completed')
    assert.deepEqual(seen, [2, 3], '续跑应只从 turn-2 开始，不重跑 turn-1')
    assert.equal(res.turns, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loop：memoryScope 开启时每轮沉淀经验，可被 recall', async () => {
  const dir = tempDir()
  const memDir = join(dir, 'mem')
  try {
    await loop(
      async ({ memorySection }) => { assert.equal(typeof memorySection, 'string'); return 'done-result' },
      {
        goal: 'ship feature', isDone: ({ turn }) => turn >= 2,
        memoryScope: 'feat-x', memoryBaseDir: memDir,
        runId: 'r-mem', stateDir: dir, maxTurns: 5,
      },
    )
    const hits = recall('feat-x', { topK: 10, baseDir: memDir })
    assert.equal(hits.length, 2, '两轮各沉淀一条')
    assert.match(hits[0].topic, /turn 2: goal reached/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loop：缺 iterate/isDone 抛 TypeError', async () => {
  await assert.rejects(loop(null, { isDone: () => true }), /iterate must be a function/)
  await assert.rejects(loop(async () => {}, {}), /isDone must be a function/)
})
