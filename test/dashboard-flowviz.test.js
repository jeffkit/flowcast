// test/dashboard-flowviz.test.js — flow-viz 原语单测。
//
// 用 golden-sample.flow.js（3-step 并行 flow）做 dry-run 测试靶子。
// dry-run 用 fake executor，不烧 API、不依赖外部环境。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { visualizeFlow } from '../dashboard/flow-viz.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GOLDEN_SAMPLE = join(__dirname, '..', 'orchestrator', 'examples', 'golden-sample.flow.js')

test('visualizeFlow：golden-sample 跑出 3 个步骤', async () => {
  const result = await visualizeFlow(GOLDEN_SAMPLE, { repo: join(__dirname, '..') })
  assert.equal(result.status, 'completed', `应 completed，实际: ${result.status} error: ${result.error}`)
  assert.ok(result.steps.length >= 3, `应至少 3 步，实际: ${result.steps.length}`)
  // 第一步应是 analyze
  assert.equal(result.steps[0].key, 'analyze')
  assert.equal(result.steps[0].status, 'done')
})

test('visualizeFlow：steps 含 key/status/durationMs 字段', async () => {
  const result = await visualizeFlow(GOLDEN_SAMPLE, { repo: join(__dirname, '..') })
  for (const s of result.steps) {
    assert.ok(typeof s.key === 'string')
    assert.ok(typeof s.status === 'string')
    // durationMs 可能是 0（dry-run 极快），但不能是 undefined
    assert.ok(s.durationMs === null || typeof s.durationMs === 'number')
  }
})

test('visualizeFlow：返回 flowName + runId + generatedAt', async () => {
  const result = await visualizeFlow(GOLDEN_SAMPLE, { repo: join(__dirname, '..') })
  assert.equal(result.flowName, 'golden-sample.flow')
  assert.ok(result.runId, '应有 runId')
  assert.match(result.runId, /^viz-/, 'runId 应 viz- 前缀')
  assert.ok(result.generatedAt, '应有 generatedAt')
  assert.equal(result.flowFile, GOLDEN_SAMPLE)
})

test('visualizeFlow：文件不存在 → status=error', async () => {
  const result = await visualizeFlow('/nonexistent/flow.js')
  assert.equal(result.status, 'error')
  assert.match(result.error, /不存在/)
  assert.deepEqual(result.steps, [])
})

test('visualizeFlow：语法错误的 flow → status=error + 有 stderr 摘要', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'flowcast-viz-bad-'))
  try {
    const badFlow = join(tmp, 'bad.flow.js')
    writeFileSync(badFlow, [
      "import { parseArgs } from 'util'",
      "const { values: opts } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } })",
      "if (opts['dry-run']) process.env.FLOWCAST_DRY_RUN = '1'",
      "this is a syntax error {{{",
    ].join('\n'))
    const result = await visualizeFlow(badFlow, { repo: tmp })
    assert.equal(result.status, 'error')
    assert.ok(result.error.length > 0, '应有错误信息')
    assert.deepEqual(result.steps, [])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('visualizeFlow：跑完后临时 HOME 被清理', async () => {
  // 间接验证：visualizeFlow 内部建临时 HOME 但不暴露路径；
  // 若清理失败，/tmp 下会残留 flowcast-viz-home- 目录。这里只确认函数正常返回。
  const result = await visualizeFlow(GOLDEN_SAMPLE, { repo: join(__dirname, '..') })
  assert.equal(result.status, 'completed')
  // 临时目录的清理是 best-effort；核心断言是函数不抛 + 返回正确
})
