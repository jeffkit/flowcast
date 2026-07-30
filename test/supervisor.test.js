import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSupervised, buildFixPrompt, extractFlowCode } from '../bin/supervisor.js'

// 最小 flow fixture（守 FLOW_API 契约：只 import flowcast + util）
const FLOW_CODE = `import { parseArgs } from 'util'\nimport { Checkpoint } from 'flowcast'\nconst cp = new Checkpoint('r', '.')\nawait cp.step('s1', () => 'x')\ncp.done({})\n`

function makeFlowDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sup-'))
  const flowAbs = join(dir, 'my-flow.js')
  writeFileSync(flowAbs, FLOW_CODE, 'utf8')
  return { dir, flowAbs }
}

// ── 纯函数 ────────────────────────────────────────────────────────────

test('extractFlowCode: 从 ```js 代码块抽取', () => {
  const out = '说明文字\n```js\nimport { x } from "y"\n```\n后续'
  assert.equal(extractFlowCode(out), 'import { x } from "y"')
})

test('extractFlowCode: 无代码块时返回整段', () => {
  assert.equal(extractFlowCode('裸代码'), '裸代码')
})

test('buildFixPrompt: 包含失败详情和 flow 代码', () => {
  const p = buildFixPrompt('step s1 报错: foo', 'import { x }')
  assert.match(p, /step s1 报错: foo/)
  assert.match(p, /import \{ x \}/)
  assert.match(p, /只修改 flow 代码/)
})

// ── runSupervised（注入假依赖）────────────────────────────────────────

test('runSupervised: 首次跑通 → return 0，不调修复 agent', async () => {
  const { dir, flowAbs } = makeFlowDir()
  let fixCalled = 0
  try {
    const code = await runSupervised({
      flowAbs, repo: dir, runId: 'r1', maxTurns: 3,
      injected: {
        runFlow: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
        validateFlow: async () => ({ ok: true }),
        runFixAgent: async () => { fixCalled++; return '```js\nx\n```' },
      },
      out: { write() {} },
    })
    assert.equal(code, 0)
    assert.equal(fixCalled, 0, '首次跑通不该调修复 agent')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: 前 2 次失败 → 修 flow → 第 3 次跑通 → return 0', async () => {
  const { dir, flowAbs } = makeFlowDir()
  const runFlowSeq = [
    { ok: false, exitCode: 1, stdout: '', stderr: 'Error: boom' },
    { ok: false, exitCode: 1, stdout: '', stderr: 'Error: boom2' },
    { ok: true, exitCode: 0, stdout: '', stderr: '' },
  ]
  let runIdx = 0
  let fixCalled = 0
  try {
    const code = await runSupervised({
      flowAbs, repo: dir, runId: 'r2', maxTurns: 5,
      injected: {
        runFlow: async () => runFlowSeq[Math.min(runIdx++, runFlowSeq.length - 1)],
        validateFlow: async () => ({ ok: true }),
        runFixAgent: async () => {
          fixCalled++
          return '```js\n// fixed\n```'
        },
      },
      out: { write() {} },
    })
    assert.equal(code, 0)
    assert.equal(fixCalled, 2, '失败 2 次应调 2 次修复 agent')
    // flow 文件应被改写（agent 输出的代码）
    assert.match(readFileSync(flowAbs, 'utf8'), /fixed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: 超过 maxTurns 仍失败 → return 1', async () => {
  const { dir, flowAbs } = makeFlowDir()
  let fixCalled = 0
  try {
    const code = await runSupervised({
      flowAbs, repo: dir, runId: 'r3', maxTurns: 2,
      injected: {
        runFlow: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'always fail' }),
        validateFlow: async () => ({ ok: true }),
        runFixAgent: async () => { fixCalled++; return '```js\nx\n```' },
      },
      out: { write() {} },
    })
    assert.equal(code, 1)
    assert.equal(fixCalled, 2, '2 轮各修一次')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: validateFlow 不通过时回喂 agent 重试', async () => {
  const { dir, flowAbs } = makeFlowDir()
  const validateSeq = [{ ok: false, error: '[syntax] bad' }, { ok: true }]
  let vIdx = 0
  let fixCalled = 0
  try {
    await runSupervised({
      flowAbs, repo: dir, runId: 'r4', maxTurns: 1,
      injected: {
        runFlow: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'fail' }),
        validateFlow: async () => validateSeq[Math.min(vIdx++, validateSeq.length - 1)],
        runFixAgent: async () => { fixCalled++; return '```js\nok\n```' },
      },
      out: { write() {} },
    })
    // 第 1 次修复校验失败 → 回喂再改（第 2 次）→ 校验通过
    assert.equal(fixCalled, 2, '校验失败应回喂重试一次')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: flow 文件不存在 → return 1', async () => {
  const code = await runSupervised({
    flowAbs: '/nonexistent/flow.js', repo: '/tmp', runId: 'r5',
    injected: {}, out: { write() {} },
  })
  assert.equal(code, 1)
})
