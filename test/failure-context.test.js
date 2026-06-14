import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

import { writeFailureContext, readAndConsumeFailureContext } from '../failure-context.js'

test('写入后可读取，内容含 reason / tailLog / provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc-'))
  const p = writeFailureContext(dir, 'attempt', {
    reason: 'BudgetExceeded',
    tailLog: 'last log line',
    provider: 'anthropic',
    model: 'sonnet',
  })
  assert.equal(existsSync(p), true)
  const content = readAndConsumeFailureContext(dir, 'attempt')
  assert.match(content, /BudgetExceeded/)
  assert.match(content, /last log line/)
  assert.match(content, /anthropic/)
  assert.match(content, /sonnet/)
  assert.match(content, /Do NOT repeat/)
  rmSync(dir, { recursive: true, force: true })
})

test('读取即消费：第二次读返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc2-'))
  writeFailureContext(dir, 'attempt', { reason: 'x' })
  const first = readAndConsumeFailureContext(dir, 'attempt')
  assert.notEqual(first, null)
  const second = readAndConsumeFailureContext(dir, 'attempt')
  assert.equal(second, null, '消费后应删除，只注入一次')
  rmSync(dir, { recursive: true, force: true })
})

test('不存在时返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc3-'))
  assert.equal(readAndConsumeFailureContext(dir, 'nope'), null)
  rmSync(dir, { recursive: true, force: true })
})

test('tailLog 含三反引号时不破坏 Markdown fence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc4-'))
  writeFailureContext(dir, 'fence', { reason: 'x', tailLog: 'line1\n```\nline2' })
  const content = readAndConsumeFailureContext(dir, 'fence')
  // 三反引号应被替换为三单引号，避免提前关闭 fence
  assert.ok(!content.includes('```\nline2'), '原始 ``` 应被替换，不应出现在 fence 内')
  assert.match(content, /'''\nline2/, "应替换为 '''")
  rmSync(dir, { recursive: true, force: true })
})

test('消费后留 owner sidecar 痕迹会被清理', () => {
  // 第二次读返回 null 之外：第一次消费留下的 owner sidecar 也必须被清掉，
  // 否则下一次写新失败上下文时旧 sidecar 会污染目录。
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc5-'))
  writeFailureContext(dir, 'attempt', { reason: 'x' })
  readAndConsumeFailureContext(dir, 'attempt')
  // 扫描目录：除了 ctxPath 主文件被删，不应有任何 .consuming.* 或 .owner.* 残留
  const leftovers = readdirSync(dir).filter(f => f.includes('.consuming.') || f.includes('.owner.'))
  assert.deepEqual(leftovers, [], '消费后 sidecar 必须清干净')
  rmSync(dir, { recursive: true, force: true })
})

test('并发 reader：先 rename 的进程拿到内容，另一个拿 null（不抛错）', () => {
  // 跨进程并发模拟：spawn 两个 node 子进程同时读，验证「first wins, rest get null」语义。
  const dir = mkdtempSync(join(tmpdir(), 'flowcast-fc-race-'))
  writeFailureContext(dir, 'attempt', { reason: 'RaceTest', tailLog: 'race' })
  const childScript = `
    import { readAndConsumeFailureContext } from '${import.meta.dirname}/../failure-context.js'
    const dir = process.argv[2]
    const r = readAndConsumeFailureContext(dir, 'attempt')
    process.stdout.write(JSON.stringify({ got: r !== null, content: r }))
  `
  const scriptPath = join(dir, '_child.mjs')
  writeFileSync(scriptPath, childScript)
  // spawn 两个 child，并发跑
  const [a, b] = [
    spawnSync('node', [scriptPath, dir], { encoding: 'utf8' }),
    spawnSync('node', [scriptPath, dir], { encoding: 'utf8' }),
  ]
  const outA = JSON.parse(a.stdout)
  const outB = JSON.parse(b.stdout)
  // 一个拿内容一个拿 null
  const gotCount = [outA, outB].filter(o => o.got).length
  assert.equal(gotCount, 1, '恰好一个进程拿到内容，另一个拿 null')
  const winner = [outA, outB].find(o => o.got)
  assert.match(winner.content, /RaceTest/)
  rmSync(dir, { recursive: true, force: true })
})
