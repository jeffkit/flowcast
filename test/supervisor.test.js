import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSupervised, buildFixPrompt, buildFollowupPrompt, extractFlowCode } from '../bin/supervisor.js'

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

test('buildFollowupPrompt: 只含新的失败详情，不含 flow 代码（靠 session 续接）', () => {
  const p = buildFollowupPrompt('新的错误: bar')
  assert.match(p, /新的错误: bar/)
  assert.doesNotMatch(p, /当前 flow 代码/, '后续轮不应再贴 flow 代码')
  assert.match(p, /之前的讨论/, '提示 agent 依赖 session 上下文')
})

// 假的修复 agent：记录每次调用的 sessionId，返回 {output, sessionId}
// sidCounter 模拟 agentproc：首次调用分配新 sessionId，后续透传同一个
function makeFakeFixAgent() {
  const calls = []
  let nextSid = 0
  return {
    fn: async ({ prompt, sessionId }) => {
      const sid = sessionId ?? `sess-${++nextSid}`
      calls.push({ prompt, sessionId: sid })
      return { output: '```js\n// fixed\n```', sessionId: sid }
    },
    calls,
  }
}

// ── runSupervised（注入假依赖）────────────────────────────────────────

test('runSupervised: 首次跑通 → return 0，不调修复 agent', async () => {
  const { dir, flowAbs } = makeFlowDir()
  const fixer = makeFakeFixAgent()
  try {
    const code = await runSupervised({
      flowAbs, repo: dir, runId: 'r1', maxTurns: 3,
      injected: {
        runFlow: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '' }),
        validateFlow: async () => ({ ok: true }),
        runFixAgent: fixer.fn,
      },
      out: { write() {} },
    })
    assert.equal(code, 0)
    assert.equal(fixer.calls.length, 0, '首次跑通不该调修复 agent')
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
  const fixer = makeFakeFixAgent()
  try {
    const code = await runSupervised({
      flowAbs, repo: dir, runId: 'r2', maxTurns: 5,
      injected: {
        runFlow: async () => runFlowSeq[Math.min(runIdx++, runFlowSeq.length - 1)],
        validateFlow: async () => ({ ok: true }),
        runFixAgent: fixer.fn,
      },
      out: { write() {} },
    })
    assert.equal(code, 0)
    assert.equal(fixer.calls.length, 2, '失败 2 次应调 2 次修复 agent')
    assert.match(readFileSync(flowAbs, 'utf8'), /fixed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: 多轮修复复用同一 session（连续上下文）', async () => {
  const { dir, flowAbs } = makeFlowDir()
  const fixer = makeFakeFixAgent()
  try {
    await runSupervised({
      flowAbs, repo: dir, runId: 'r-sess', maxTurns: 3,
      injected: {
        runFlow: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'fail' }),
        validateFlow: async () => ({ ok: true }),
        runFixAgent: fixer.fn,
      },
      out: { write() {} },
    })
    // 3 轮各调一次修复 agent，应全部用同一个 sessionId
    assert.equal(fixer.calls.length, 3)
    const sids = fixer.calls.map(c => c.sessionId)
    assert.ok(sids.every(s => s === sids[0]), `3 轮应复用同一 session，实际：${JSON.stringify(sids)}`)
    // 第 1 轮 prompt 含 flow 代码（建立上下文）；第 2、3 轮只抛新问题（session 续接）
    assert.match(fixer.calls[0].prompt, /当前 flow 代码/, '首轮应贴 flow 代码')
    assert.doesNotMatch(fixer.calls[1].prompt, /当前 flow 代码/, '后续轮不应再贴 flow 代码')
    assert.doesNotMatch(fixer.calls[2].prompt, /当前 flow 代码/, '后续轮不应再贴 flow 代码')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: 超过 maxTurns 仍失败 → return 1', async () => {
  const { dir, flowAbs } = makeFlowDir()
  const fixer = makeFakeFixAgent()
  try {
    const code = await runSupervised({
      flowAbs, repo: dir, runId: 'r3', maxTurns: 2,
      injected: {
        runFlow: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'always fail' }),
        validateFlow: async () => ({ ok: true }),
        runFixAgent: fixer.fn,
      },
      out: { write() {} },
    })
    assert.equal(code, 1)
    assert.equal(fixer.calls.length, 2, '2 轮各修一次')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: validateFlow 不通过时回喂 agent 重试（同 session）', async () => {
  const { dir, flowAbs } = makeFlowDir()
  const validateSeq = [{ ok: false, error: '[syntax] bad' }, { ok: true }]
  let vIdx = 0
  const fixer = makeFakeFixAgent()
  try {
    await runSupervised({
      flowAbs, repo: dir, runId: 'r4', maxTurns: 1,
      injected: {
        runFlow: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: 'fail' }),
        validateFlow: async () => validateSeq[Math.min(vIdx++, validateSeq.length - 1)],
        runFixAgent: fixer.fn,
      },
      out: { write() {} },
    })
    // 第 1 次修复校验失败 → 回喂再改（第 2 次）→ 校验通过
    assert.equal(fixer.calls.length, 2, '校验失败应回喂重试一次')
    // 两次回喂应复用同一 session
    assert.equal(fixer.calls[0].sessionId, fixer.calls[1].sessionId, '回喂应续接同一 session')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runSupervised: flow 文件不存在 → return 1', async () => {
  const code = await runSupervised({
    flowAbs: '/nonexistent/flow.js', repo: '/tmp', runId: 'r5',
    injected: {}, out: { write() {} },
  })
  assert.equal(code, 1)
})
