import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateFlow, scanImports, GOLDEN_SAMPLE } from '../orchestrator/index.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── scanImports ──────────────────────────────────────────────────

test('scanImports: 白名单放行', () => {
  const src = `import { Checkpoint } from 'flowcast'\nimport { parseArgs } from 'util'`
  assert.deepEqual(scanImports(src), [])
})

test('scanImports: 抓非白名单 import（fs / child_process / 动态）', () => {
  const src = `
    import { readFileSync } from 'fs'
    import { execSync } from 'child_process'
    const x = await import('net')
    const y = require('os')
  `
  const bad = scanImports(src)
  assert.ok(bad.includes('fs'))
  assert.ok(bad.includes('child_process'))
  assert.ok(bad.includes('net'))
  assert.ok(bad.includes('os'))
})

test('scanImports: 抓 flowcast 子路径违规（dashboard 是宿主观测，不给生成 flow）', () => {
  // dashboard 是宿主 CLI/SDK 用的，不是给被编排对象自循环的。
  // 即使 `flowcast` 在白名单里，`flowcast/dashboard` 子路径仍被禁止。
  const src = `
    import { collectRuns } from 'flowcast/dashboard'
    import { renderHtml } from 'flowcast/dashboard/index'
    import { ok } from 'flowcast/dashboard/something/deep'
  `
  const bad = scanImports(src)
  assert.ok(bad.includes('flowcast/dashboard'), '顶层子路径必须被抓')
  assert.ok(bad.includes('flowcast/dashboard/index'), '显式 /index 子路径必须被抓')
  assert.ok(bad.includes('flowcast/dashboard/something/deep'), '深层子路径必须被抓')
})

// ── validateFlow ─────────────────────────────────────────────────

test('validateFlow: 黄金样例三关全过', async () => {
  const r = await validateFlow(GOLDEN_SAMPLE, { cwd: REPO })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(r.checks, ['syntax', 'imports', 'dry-run'])
})

test('validateFlow: 语法错误被拦（syntax 关）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-bad-'))
  try {
    const f = join(dir, 'syntax-err.js')
    writeFileSync(f, `import { x } from 'flowcast'\nfunction main( {\n`)
    const r = await validateFlow(f, { cwd: REPO })
    assert.equal(r.ok, false)
    assert.match(r.error, /^\[syntax\]/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateFlow: 违规 import 被拦（imports 关）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-bad-'))
  try {
    const f = join(dir, 'bad-import.js')
    writeFileSync(f, `import { Checkpoint } from 'flowcast'\nimport { writeFileSync } from 'fs'\nawait Promise.resolve()\n`)
    const r = await validateFlow(f, { cwd: REPO })
    assert.equal(r.ok, false)
    assert.match(r.error, /^\[imports\]/)
    assert.match(r.error, /fs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
