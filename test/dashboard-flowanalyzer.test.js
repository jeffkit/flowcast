// test/dashboard-flowanalyzer.test.js — flow-analyzer AST 单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { analyzeFlow } from '../dashboard/flow-analyzer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(__dirname, '..', 'orchestrator', 'examples', 'golden-sample.flow.js')
const PGE = join(__dirname, '..', 'examples', 'pge.flow.js')

// ── golden-sample.flow.js（最简单的 3 步静态 flow）──────────────

test('analyzeFlow(golden-sample)：3 个静态 step，全在 main scope', () => {
  const src = [
    "import { Checkpoint, parallel } from 'flowcast'",
    "const cp = new Checkpoint('r')",
    "async function main() {",
    "  await cp.step('analyze', () => parallel([]))",
    "  await cp.step('gate.lint', () => null)",
    "  await cp.step('synthesize', () => null)",
    "}",
    "await main()",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  assert.equal(result.steps.length, 3)
  assert.equal(result.steps[0].key, 'analyze')
  assert.equal(result.steps[1].key, 'gate.lint')
  assert.equal(result.steps[2].key, 'synthesize')
  for (const s of result.steps) {
    assert.equal(s.dynamic, false)
    assert.equal(s.scope, 'main')
  }
})

test('analyzeFlow(golden-sample)：parallel group 识别', () => {
  const src = [
    "import { Checkpoint, parallel } from 'flowcast'",
    "const cp = new Checkpoint('r')",
    "async function main() {",
    "  await cp.step('analyze', () => parallel([",
    "    () => cp.step('a1', () => null),",  // lambda 内的 step 仍被下钻（动态深度 > 0）
    "    () => cp.step('a2', () => null),",
    "  ]))",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  // walker 下钻所有节点：analyze + a1 + a2 都收
  assert.equal(result.steps.length, 3)
  assert.equal(result.steps[0].key, 'analyze')
  // analyze 的 cp.step 参数 lambda 内有 parallel → 穿透标记 inParallelDepth=1
  assert.equal(result.steps[0].inParallelDepth, 1, 'analyze 的参数 lambda 含 parallel，应穿透标记')
  assert.equal(result.steps[1].key, 'a1')
  assert.equal(result.steps[1].inParallelDepth, 1, 'a1 在 parallel 嵌套内')
  assert.equal(result.steps[2].key, 'a2')
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].type, 'parallel')
})

// ── 模板字符串 / 动态 key ─────────────────────────────────────

test('analyzeFlow：模板字符串 step key 标记 dynamic + template', () => {
  const src = [
    "import { Checkpoint } from 'flowcast'",
    "const cp = new Checkpoint('r')",
    "async function main() {",
    "  for (let i = 0; i < 3; i++) {",
    "    await cp.step(`sprint-${i+1}-${name}`, () => null)",
    "  }",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0].dynamic, true)
  // template 字段去掉反引号，${} 包裹表达式（前端展示友好）
  assert.equal(result.steps[0].template, 'sprint-${i+1}-${name}')
  assert.match(result.steps[0].key, /sprint/)
  assert.equal(result.steps[0].inLoop, true)
  assert.equal(result.steps[0].inLoopKind, 'for')
})

test('analyzeFlow：无表达式的模板字符串 → 静态', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "await cp.step(`static-key`, () => null)",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.steps[0].dynamic, false)
  assert.equal(result.steps[0].key, 'static-key')
})

// ── 函数作用域 ──────────────────────────────────────────────────

test('analyzeFlow：helper 函数里的 step → scope=helper 名', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "async function runProfile(name) {",
    "  await cp.step('helper-step', () => null)",
    "}",
    "await runProfile('x')",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.steps[0].scope, 'runProfile')
})

test('analyzeFlow：匿名箭头函数作为值变量时 → 拿到变量名', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "const lambda = () => cp.step('named-arrow-step', () => null)",
    "await lambda()",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.steps[0].scope, 'lambda', 'var name = arrow → 应拿到变量名')
})

test('analyzeFlow：arrow 在变量 init 链里 → 拿到最近变量名（arr）', () => {
  // const arr = [1,2,3].map(() => ...) 里的 arrow 属于 arr 的 init 链
  const src = [
    "const cp = { step: (k, f) => null }",
    "const arr = [1,2,3].map(() => cp.step('inline-step', () => null))",
  ].join('\n')
  const result = analyzeFlow(src)
  // arrow 通过祖先链的最近 VariableDeclarator 拿到名字 arr（比 <anonymous> 信息量大）
  assert.equal(result.steps[0].scope, 'arr')
})

test('analyzeFlow：完全匿名 arrow（非变量 init）→ scope=<anonymous>', () => {
  // 直接调用匿名 arrow：(() => cp.step(...))()
  // 注意：上一条语句必须带分号，否则 ASI 会把 IIFE 并进 const 声明
  const src = [
    "const cp = { step: (k, f) => null };",
    "(() => cp.step('bare-step', () => null))()",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.steps[0].scope, '<anonymous>')
})

// ── loop() / parallel() / fanOut() 分组 ────────────────────────

test('analyzeFlow：loop() 标记 inLoop=true + group', () => {
  const src = [
    "import { loop } from 'flowcast'",
    "const cp = { step: (k, f) => null }",
    "async function main() {",
    "  await loop(async (turn) => {",
    "    await cp.step('turn-loop-step', () => null)",
    "  })",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.steps[0].inLoop, true)
  assert.equal(result.steps[0].inLoopKind, 'loop()')
  assert.ok(result.groups.some(g => g.type === 'loop'))
})

test('analyzeFlow：fanOut group', () => {
  const src = [
    "import { fanOut } from 'flowcast'",
    "const cp = { step: (k, f) => null }",
    "async function main() {",
    "  await fanOut([1, 2, 3], () => null)",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.ok(result.groups.some(g => g.type === 'fanOut'))
})

// ── 解析失败 ────────────────────────────────────────────────────

test('analyzeFlow：语法错误 → parseError 不抛', () => {
  const src = "const cp = { step: (k, f) => null }; cp.step('x' () => null)"
  const result = analyzeFlow(src)
  assert.ok(result.parseError, '应返回 parseError')
  assert.match(result.parseError.message, /SyntaxError|Unexpected/i)
  assert.deepEqual(result.steps, [])
  assert.deepEqual(result.groups, [])
})

// ── 真实文件 ────────────────────────────────────────────────────

test('analyzeFlow(golden-sample.flow.js 真实文件)：解析成功', () => {
  const src = readFileSync(GOLDEN, 'utf8')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  // golden-sample 应至少有 analyze / gate.lint / synthesize 三步
  const keys = result.steps.map(s => s.key)
  assert.ok(keys.includes('analyze'))
  assert.ok(keys.includes('gate.lint'))
  assert.ok(keys.includes('synthesize'))
})

test('analyzeFlow(pge.flow.js 真实文件)：plan / commit.land 等字面量 + 动态 step', () => {
  const src = readFileSync(PGE, 'utf8')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null, 'pge 应能解析')
  const keys = result.steps.map(s => s.key)
  // 字面量 step（直接是字符串字面量）
  assert.ok(keys.includes('plan'), '应有 plan 静态 step')
  assert.ok(keys.includes('commit.land'), '应有 commit.land 静态 step')
  // 至少一个动态 step（pge 的 sprint tag 是变量引用 → 模板在 'tag = `sprint-${...}`' 那里，
  // 但 step() 第一个参数是变量 tag，所以 analyzer 把它标为 dynamic、template=null；
  // crossProviderReview 内的 stepName 模板应被识别为 dynamic + template）
  const dynamicSteps = result.steps.filter(s => s.dynamic)
  assert.ok(dynamicSteps.length > 0, '应有动态 step（template 或变量引用）')
  // 至少有字面量 step 在 main scope
  const planStep = result.steps.find(s => s.key === 'plan')
  assert.ok(planStep, 'plan 静态 step 应在结果中')
  assert.equal(planStep.scope, 'main')
})
// ── if/else 分支检测 ─────────────────────────────────────────────

test('analyzeFlow：if/else 分支标记', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "async function main() {",
    "  if (cond) {",
    "    await cp.step('then-step', () => null)",
    "  } else {",
    "    await cp.step('else-step', () => null)",
    "  }",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  const thenStep = result.steps.find(s => s.key === 'then-step')
  const elseStep = result.steps.find(s => s.key === 'else-step')
  assert.ok(thenStep, '应有 then-step')
  assert.equal(thenStep.inIf, true)
  assert.equal(thenStep.inIfBranch, 'then')
  assert.ok(elseStep, '应有 else-step')
  assert.equal(elseStep.inIf, true)
  assert.equal(elseStep.inIfBranch, 'else')
})

test('analyzeFlow：非 if 内 step 的 inIf=false', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "await cp.step('plain', () => null)",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.steps[0].inIf, false)
  assert.equal(result.steps[0].inIfBranch, null)
})

// ── loop 穿透 ───────────────────────────────────────────────────

test('analyzeFlow：step 参数 lambda 内的 loop 穿透标记', () => {
  const src = [
    "import { loop } from 'flowcast'",
    "const cp = { step: (k, f) => null }",
    "await cp.step('wrapper', () => loop(async (turn) => {",
    "  await cp.step('inner', () => null)",
    "}))",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  const wrapper = result.steps.find(s => s.key === 'wrapper')
  assert.ok(wrapper, '应有 wrapper step')
  assert.equal(wrapper.inLoop, true, 'wrapper 参数 lambda 含 loop，应穿透标记')
  assert.equal(wrapper.inLoopKind, 'loop()')
})

test('analyzeFlow：fanOut 穿透标记', () => {
  const src = [
    "import { fanOut } from 'flowcast'",
    "const cp = { step: (k, f) => null }",
    "await cp.step('fan', () => fanOut([1], () => null))",
  ].join('\n')
  const result = analyzeFlow(src)
  const fan = result.steps.find(s => s.key === 'fan')
  assert.equal(fan.inFanOut, true, 'fan 参数 lambda 含 fanOut，应穿透标记')
})

// ── branches（if/else 分叉结构）─────────────────────────────────

test('analyzeFlow：if/else 输出 branches 结构', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "async function main() {",
    "  if (cond) {",
    "    await cp.step('then-step', () => null)",
    "  } else {",
    "    await cp.step('else-step', () => null)",
    "  }",
    "  await cp.step('after', () => null)",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  assert.equal(result.branches.length, 1)
  const b = result.branches[0]
  assert.equal(b.type, 'if')
  assert.deepEqual(b.thenSteps.map(i => result.steps[i].key), ['then-step'])
  assert.deepEqual(b.elseSteps.map(i => result.steps[i].key), ['else-step'])
})

test('analyzeFlow：嵌套 if 的 step 归内层 branch', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "if (outer) {",
    "  await cp.step('outer-step', () => null)",
    "  if (inner) {",
    "    await cp.step('inner-step', () => null)",
    "  }",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.branches.length, 2)
  const outer = result.branches[0]
  const inner = result.branches[1]
  // outer.thenSteps 应只含 outer-step（内层 step 归内层 branch）
  assert.deepEqual(outer.thenSteps.map(i => result.steps[i].key), ['outer-step'])
  assert.deepEqual(inner.thenSteps.map(i => result.steps[i].key), ['inner-step'])
})

// ── group.actions（loop 内部动作）────────────────────────────────

test('analyzeFlow：loop group 提取内部动作', () => {
  const src = [
    "import { loop } from 'flowcast'",
    "const cp = { step: (k, f) => null }",
    "await loop(async () => {",
    "  await runProfile('gen', 'task')",
    "  await runGate({ name: 'test' })",
    "  read('file')",   // 噪音，应被过滤
    "})",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.groups.length, 1)
  const g = result.groups[0]
  assert.equal(g.type, 'loop')
  const names = (g.actions ?? []).map(a => a.name)
  assert.ok(names.includes('runProfile'), '应含 runProfile')
  assert.ok(names.includes('runGate'), '应含 runGate')
  assert.ok(!names.includes('read'), 'read 是噪音应被过滤')
})

test('analyzeFlow(pge 真实文件)：loop actions 含 runProfile/runGate', () => {
  const src = readFileSync(PGE, 'utf8')
  const result = analyzeFlow(src)
  const loopGroup = result.groups.find(g => g.type === 'loop')
  assert.ok(loopGroup, 'pge 应有 loop group')
  const names = (loopGroup.actions ?? []).map(a => a.name)
  assert.ok(names.includes('runProfile'), 'loop 内应调 runProfile')
})

// ── for/while 循环 group ─────────────────────────────────────────

test('analyzeFlow：for 循环建 group', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "async function main() {",
    "  for (let i = 0; i < 3; i++) {",
    "    await cp.step('loop-step', () => null)",
    "  }",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  const forGroup = result.groups.find(g => g.type === 'for')
  assert.ok(forGroup, '应有 for group')
  assert.deepEqual(forGroup.childStepIndexes.map(i => result.steps[i].key), ['loop-step'])
})

test('analyzeFlow：while 循环建 group', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "while (cond) {",
    "  await cp.step('while-step', () => null)",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  const whileGroup = result.groups.find(g => g.type === 'while')
  assert.ok(whileGroup, '应有 while group')
  assert.deepEqual(whileGroup.childStepIndexes.map(i => result.steps[i].key), ['while-step'])
})

test('analyzeFlow：空 for（无 step）不建 group', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "for (let i = 0; i < 3; i++) {",
    "  console.log(i)",
    "}",
    "await cp.step('after', () => null)",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.groups.filter(g => g.type === 'for').length, 0, '空 for 不应建 group')
})

test('analyzeFlow：嵌套 for 两个 group', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "for (const g of gates) {",
    "  for (let attempt = 0; attempt < 3; attempt++) {",
    "    await cp.step(`gate.${g.name}.fix-${attempt}`, () => null)",
    "  }",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  const forGroups = result.groups.filter(g => g.type === 'for')
  assert.equal(forGroups.length, 2, '嵌套 for 应有两个 group')
  // 外层 group 行号更小：for (const g...) 在 L2，内层 for (let attempt...) 在 L3
  const outer = forGroups.find(g => g.line === 2)
  const inner = forGroups.find(g => g.line === 3)
  assert.ok(outer && inner, '应能区分内外层')
  assert.ok(outer.childStepIndexes.length > 0 && inner.childStepIndexes.length > 0)
})

test('analyzeFlow(self-improve 真实文件)：for group 覆盖循环 step', () => {
  const src = readFileSync('/Users/kongjie/projects/infra4agent/recursive/.dev/flows/self-improve.flow.js', 'utf8')
  const result = analyzeFlow(src)
  const forGroups = result.groups.filter(g => g.type === 'for')
  assert.ok(forGroups.length >= 5, `应有至少 5 个 for group，实际 ${forGroups.length}`)
  // 至少一个 for group 含 review 或 gate 相关 step
  const hasReviewOrGate = forGroups.some(g =>
    g.childStepIndexes.some(i => /review|gate/.test(result.steps[i].key)))
  assert.ok(hasReviewOrGate, 'for group 应覆盖 review/gate step')
})

// ── calls（函数调用图）──────────────────────────────────────────

test('analyzeFlow：输出 calls（函数调用图）', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "async function helper() { await cp.step('inner', () => null) }",
    "async function main() {",
    "  await cp.step('start', () => null)",
    "  await helper()",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  assert.equal(result.parseError, null)
  const mainCalls = result.calls.filter(c => c.caller === 'main')
  assert.ok(mainCalls.some(c => c.callee === 'helper'), 'main 应调用 helper')
})

test('analyzeFlow：calls 排除内置函数', () => {
  const src = [
    "const cp = { step: (k, f) => null }",
    "async function main() {",
    "  console.log('x')",
    "  await cp.step('start', () => null)",
    "}",
  ].join('\n')
  const result = analyzeFlow(src)
  const mainCalls = result.calls.filter(c => c.caller === 'main')
  assert.ok(!mainCalls.some(c => c.callee === 'log'), 'console.log 不应算 helper')
})
