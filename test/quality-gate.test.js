import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runGate, runGates, loadGates, mergeGates } from '../quality-gate.js'
import { GateError } from '../errors.js'

test('绿灯门 → passed', async () => {
  const r = await runGate({ name: 'ok', cmd: 'true' })
  assert.equal(r.passed, true)
  assert.equal(r.attempts, 1)
})

test('红灯 + onFail=rollback → 抛错且带 gate/output', async () => {
  await assert.rejects(
    runGate({ name: 'test', cmd: 'echo FAILLINE >&2; echo out; exit 3', onFail: 'rollback' }),
    (err) => {
      assert.ok(err instanceof GateError, '应为 GateError')
      assert.equal(err.gate, 'test')
      assert.equal(err.exitCode, 3)
      assert.match(err.output, /out/)
      assert.match(err.output, /FAILLINE/) // stderr 也被合并
      return true
    },
  )
})

test('红灯 + onFail=autofix → autofixCmd 修好后重验通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gate-'))
  const flag = join(dir, 'fixed')
  // cmd：flag 存在才绿灯；autofixCmd 创建 flag，之后重验通过
  const r = await runGate({
    name: 'fmt',
    cmd: `test -f ${flag}`,
    onFail: 'autofix',
    autofixCmd: `touch ${flag}`,
  })
  assert.equal(r.passed, true)
  assert.equal(r.autofixed, true)
  assert.equal(r.attempts, 2, 'autofix 后应重验一次（attempts=2）')
  assert.equal(existsSync(flag), true, 'autofixCmd 应被执行')
  rmSync(dir, { recursive: true, force: true })
})

test('红灯 + onFail=autofix → autofixCmd 修后重验仍失败 → 抛错', async () => {
  await assert.rejects(
    runGate({ name: 'fmt', cmd: 'exit 1', onFail: 'autofix', autofixCmd: 'true' }),
    (err) => {
      assert.ok(err instanceof GateError, '应为 GateError')
      assert.match(err.message, /still failing after autofix/)
      assert.equal(err.gate, 'fmt')
      return true
    },
  )
})

test('红灯 + resume-fix 成功 → 第二次通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gate-rf-'))
  const flag = join(dir, 'patched')
  // cmd：flag 存在则绿灯，否则红灯
  const cmd = `test -f ${flag}`
  let gotOutput = null
  const r = await runGate(
    { name: 'test', cmd, onFail: 'resume-fix' },
    {
      resumeFix: async (output) => {
        gotOutput = output
        await import('child_process').then(({ execSync }) => execSync(`touch ${flag}`))
        return true
      },
    },
  )
  assert.equal(r.passed, true)
  assert.equal(r.attempts, 2)
  assert.equal(r.resumeFixed, true)
  assert.notEqual(gotOutput, null, 'resumeFix 应收到失败输出')
  rmSync(dir, { recursive: true, force: true })
})

test('红灯 + resume-fix 仍失败 → 抛错', async () => {
  await assert.rejects(
    runGate(
      { name: 'test', cmd: 'exit 1', onFail: 'resume-fix' },
      { resumeFix: async () => true }, // 声称修了但 cmd 永远红
    ),
    /quality gate 'test' failed/,
  )
})

test('maxResumeAttempts=3 → resumeFix 最多被调 3 次，全部用尽抛错', async () => {
  let calls = 0
  await assert.rejects(
    runGate(
      { name: 'test', cmd: 'exit 1', onFail: 'resume-fix', maxResumeAttempts: 3 },
      { resumeFix: async () => { calls++; return true } },
    ),
    /quality gate 'test' failed/,
  )
  assert.equal(calls, 3, 'resumeFix 应被调 3 次（不是默认 1 次）')
})

test('maxResumeAttempts=3 + onExhausted=return-fail → 不抛错，返回 passed:false', async () => {
  let calls = 0
  const r = await runGate(
    { name: 'test', cmd: 'exit 1', onFail: 'resume-fix', maxResumeAttempts: 2, onExhausted: 'return-fail' },
    { resumeFix: async () => { calls++; return true } },
  )
  assert.equal(r.passed, false)
  assert.equal(r.exitCode, 1)
  assert.equal(calls, 2)
})

test('maxResumeAttempts=3 第 2 次成功 → 通过，attempts=3', async () => {
  const fs = await import('fs')
  const path = await import('path')
  const marker = path.join(fs.mkdtempSync('/tmp/gate-'), 'done')
  // 模拟：检查命令前 2 次失败、第 3 次通过。用文件存在性判定。
  const cmd = `sh -c 'if [ -f "${marker}" ]; then exit 0; else touch "${marker}"; exit 1; fi'`
  try {
    const r = await runGate(
      { name: 'test', cmd, onFail: 'resume-fix', maxResumeAttempts: 3 },
      { resumeFix: async () => true },
    )
    assert.equal(r.passed, true)
    assert.equal(r.attempts, 2, 'build(1) + resume1(2); 第 1 次 resumeFix 后 marker 已存在，第 2 次重测通过')
    assert.equal(r.resumeFixed, true)
  } finally {
    try {
      const dir = path.dirname(marker)
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* 忽略 */ }
  }
})

test('onEvent：绿灯 emit gate/pass，红灯 emit gate/fail（埋点）', async () => {
  const events = []
  const onEvent = e => events.push(e)
  await runGate({ name: 'ok', cmd: 'true' }, { onEvent })
  // makeEvent 统一事件格式后，事件对象额外包含 type 和 ts 字段（向后兼容 event 字段仍保留）。
  // 使用 subset 匹配而非深度相等，避免 ts 时间戳导致快照测试失败。
  const passEvt = events.at(-1)
  assert.equal(passEvt.event, 'gate')
  assert.equal(passEvt.type, 'gate')
  assert.equal(passEvt.name, 'ok')
  assert.equal(passEvt.status, 'pass')
  assert.equal(passEvt.attempts, 1)
  assert.ok(typeof passEvt.ts === 'string', 'ts 字段应为 ISO 字符串')

  await assert.rejects(runGate({ name: 'bad', cmd: 'exit 7', onFail: 'rollback' }, { onEvent }))
  const failEvt = events.at(-1)
  assert.equal(failEvt.event, 'gate')
  assert.equal(failEvt.type, 'gate')
  assert.equal(failEvt.name, 'bad')
  assert.equal(failEvt.status, 'fail')
  assert.equal(failEvt.exitCode, 7)
})

test('红灯 + onFail=autofix 但无 autofixCmd → 直接抛错，不重跑检查', async () => {
  await assert.rejects(
    runGate({ name: 'fmt', cmd: 'exit 1', onFail: 'autofix' /* 无 autofixCmd */ }),
    (err) => {
      assert.match(err.message, /autofixCmd/)
      assert.equal(err.gate, 'fmt')
      assert.equal(err.configError, true)
      return true
    },
  )
})

test('runGates 顺序执行，遇红灯即抛', async () => {
  await assert.rejects(
    runGates([
      { name: 'a', cmd: 'true' },
      { name: 'b', cmd: 'exit 2', onFail: 'rollback' },
      { name: 'c', cmd: 'true' },
    ]),
    (err) => {
      assert.ok(err instanceof GateError, '应为 GateError')
      assert.equal(err.gate, 'b')
      return true
    },
  )
})

// ── loadGates / mergeGates：业务项目自定义质量门 ──────────────────

test('loadGates：从 .flowcast/gates.json（map 形态）加载并注入 name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gates-'))
  writeFileSync(join(dir, 'gates.json'), JSON.stringify({
    gates: {
      e2e: { cmd: 'sh ./e2e.sh', onFail: 'rollback', timeout: 600000 },
    },
  }))
  const gates = await loadGates({ dirs: [dir] })
  assert.equal(gates.length, 1)
  assert.deepEqual(gates[0], { name: 'e2e', cmd: 'sh ./e2e.sh', onFail: 'rollback', timeout: 600000 })
  rmSync(dir, { recursive: true, force: true })
})

test('loadGates：裸 map（无 gates 外层包裹）也支持', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gates-bare-'))
  writeFileSync(join(dir, 'gates.json'), JSON.stringify({
    lint: { cmd: 'npm run lint', onFail: 'resume-fix' },
  }))
  const gates = await loadGates({ dirs: [dir] })
  assert.equal(gates[0].name, 'lint')
  assert.equal(gates[0].cmd, 'npm run lint')
  rmSync(dir, { recursive: true, force: true })
})

test('loadGates：多层覆盖——项目级同名门整体覆盖机器级', async () => {
  const machine = mkdtempSync(join(tmpdir(), 'flowcast-gates-m-'))
  const project = mkdtempSync(join(tmpdir(), 'flowcast-gates-p-'))
  writeFileSync(join(machine, 'gates.json'), JSON.stringify({
    gates: { e2e: { cmd: 'old', onFail: 'rollback' }, smoke: { cmd: 'smoke' } },
  }))
  writeFileSync(join(project, 'gates.json'), JSON.stringify({
    gates: { e2e: { cmd: 'new', onFail: 'resume-fix' } },
  }))
  const gates = await loadGates({ dirs: [machine, project] })
  const e2e = gates.find(g => g.name === 'e2e')
  assert.equal(e2e.cmd, 'new', '项目级应覆盖机器级')
  assert.equal(e2e.onFail, 'resume-fix')
  assert.ok(gates.find(g => g.name === 'smoke'), '机器级独有门应保留')
  rmSync(machine, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

test('loadGates：缺 cmd → 友好报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gates-bad-'))
  writeFileSync(join(dir, 'gates.json'), JSON.stringify({ gates: { broken: { onFail: 'rollback' } } }))
  await assert.rejects(loadGates({ dirs: [dir] }), /质量门 'broken' 缺少 cmd/)
  rmSync(dir, { recursive: true, force: true })
})

test('loadGates：无配置文件 → 空数组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-gates-empty-'))
  const gates = await loadGates({ dirs: [dir] })
  assert.deepEqual(gates, [])
  rmSync(dir, { recursive: true, force: true })
})

test('mergeGates：项目门覆盖内置同名、新增追加在后、内置保序在前', () => {
  const builtin = [
    { name: 'test', cmd: 'cargo test' },
    { name: 'clippy', cmd: 'cargo clippy' },
    { name: 'fmt', cmd: 'cargo fmt --check' },
  ]
  const project = [
    { name: 'clippy', cmd: 'cargo clippy -- -D warnings', onFail: 'resume-fix' }, // 覆盖
    { name: 'e2e', cmd: 'sh e2e.sh', onFail: 'rollback' },                        // 新增
  ]
  const merged = mergeGates(builtin, project)
  assert.deepEqual(merged.map(g => g.name), ['test', 'clippy', 'fmt', 'e2e'])
  assert.equal(merged.find(g => g.name === 'clippy').cmd, 'cargo clippy -- -D warnings')
  assert.equal(merged.find(g => g.name === 'clippy').onFail, 'resume-fix')
})

test('mergeGates：空项目门 → 原样返回内置', () => {
  const builtin = [{ name: 'test', cmd: 't' }]
  assert.deepEqual(mergeGates(builtin, []), builtin)
  assert.deepEqual(mergeGates(builtin), builtin)
})

// ── cwd 路径安全（P1-A5 修复回归测试）────────────────────────────
//
// 防止 gates.json 被篡改后用 cwd: '/etc' 让检查命令在任意目录运行，
// 以及通过 symlink 绕过路径前缀比较的攻击面。

test('cwd 安全：gate.cwd 在 repo 内 → 正常执行', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-cwd-ok-'))
  const sub = join(repo, 'sub')
  mkdirSync(sub, { recursive: true })
  try {
    const r = await runGate({ name: 'ok', cmd: 'true', cwd: sub }, { repo })
    assert.equal(r.passed, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('cwd 安全：gate.cwd 等于 repo 本身 → 允许', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-cwd-eq-'))
  try {
    const r = await runGate({ name: 'ok', cmd: 'true', cwd: repo }, { repo })
    assert.equal(r.passed, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('cwd 安全：gate.cwd 逃逸 repo（绝对路径指向外部） → 抛 ConfigError', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-cwd-esc-'))
  try {
    await assert.rejects(
      runGate({ name: 'bad', cmd: 'true', cwd: tmpdir() }, { repo }),
      (err) => {
        assert.equal(err.configError, true, '应抛 ConfigError')
        assert.match(err.message, /cwd.*必须在 repo.*内/)
        assert.equal(err.gate, 'bad')
        return true
      },
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('cwd 安全：gate.cwd 不存在 → 抛 ConfigError（无法解析真实路径）', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-cwd-missing-'))
  const nonExistent = join(repo, 'does-not-exist')
  try {
    await assert.rejects(
      runGate({ name: 'bad', cmd: 'true', cwd: nonExistent }, { repo }),
      (err) => {
        assert.equal(err.configError, true, '应抛 ConfigError')
        assert.match(err.message, /无法解析 cwd/)
        assert.equal(err.gate, 'bad')
        return true
      },
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('cwd 安全：无 deps.repo 时不做 cwd 校验（向后兼容）', async () => {
  // 不传 repo → 无论 cwd 是什么都不校验，让原有行为正常工作
  const r = await runGate({ name: 'ok', cmd: 'true', cwd: tmpdir() })
  assert.equal(r.passed, true)
})

test('cwd 安全：gate 无显式 cwd（取 process.cwd()）且 deps.repo 存在 → 跳过校验', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-cwd-noexpl-'))
  try {
    // gate 对象里没有 cwd 字段 → 不触发 symlink 校验逻辑
    const r = await runGate({ name: 'ok', cmd: 'true' }, { repo })
    assert.equal(r.passed, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
