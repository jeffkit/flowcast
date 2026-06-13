import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runOrchestrate } from '../orchestrator/index.js'
import { GOLDEN_SAMPLE } from '../orchestrator/paths.js'
import { flowcastDir } from '../dirs.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const goldenCode = readFileSync(GOLDEN_SAMPLE, 'utf8')
const fence = (code) => '```js\n' + code + '\n```'
const cleanRun = (id) => rmSync(join(flowcastDir(REPO), 'runs', id), { recursive: true, force: true })

// ── runOrchestrate（fake 生成，不烧 API）─────────────────────────

test('runOrchestrate: 位置参数当 goal → 生成 → 校验 → dry-run 跑通，exit 0', async () => {
  const id = `t-cli-ok-${Date.now()}`
  try {
    const code = await runOrchestrate(
      ['analyze the repo', '--repo', REPO, '--run-id', id, '--dry-run'],
      { generate: async () => fence(goldenCode), onData: () => {} },
    )
    assert.equal(code, 0)
    // 生成产物落盘到 run 目录
    assert.ok(existsSync(join(flowcastDir(REPO), 'runs', id, 'flow.mjs')))
  } finally { cleanRun(id) }
})

test('runOrchestrate: 同 runId 二次调用 → 续跑锁定，不重新生成', async () => {
  const id = `t-cli-reuse-${Date.now()}`
  try {
    await runOrchestrate(['x', '--repo', REPO, '--run-id', id, '--dry-run'],
      { generate: async () => fence(goldenCode), onData: () => {} })

    let genCalled = false
    const code = await runOrchestrate(['x', '--repo', REPO, '--run-id', id, '--dry-run'],
      { generate: async () => { genCalled = true; return fence('bad') }, onData: () => {} })
    assert.equal(code, 0)
    assert.equal(genCalled, false)
  } finally { cleanRun(id) }
})

test('runOrchestrate: 缺 goal → 退出码 1', async () => {
  const code = await runOrchestrate(['--repo', REPO], { generate: async () => '', onData: () => {} })
  assert.equal(code, 1)
})

test('runOrchestrate: 生成始终违规 → 生成阶段失败，退出码 1', async () => {
  const id = `t-cli-bad-${Date.now()}`
  try {
    const code = await runOrchestrate(
      ['x', '--repo', REPO, '--run-id', id, '--dry-run'],
      { generate: async () => fence("import { x } from 'fs'\nawait Promise.resolve()"), onData: () => {} },
    )
    assert.equal(code, 1)
  } finally { cleanRun(id) }
})
