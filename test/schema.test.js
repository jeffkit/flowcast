import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractJson, validateSchema, stubFromSchema, runStructured } from '../schema.js'
import { SchemaError } from '../errors.js'

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
    impact: { type: 'string', enum: ['high', 'low'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'count'],
}

// ── extractJson ──────────────────────────────────────────────────

test('extractJson: ```json fenced 块', () => {
  const r = extractJson('前言\n```json\n{"a":1}\n```\n后记')
  assert.deepEqual(r, { a: 1 })
})

test('extractJson: 裸文本里的平衡对象（前后有噪声）', () => {
  const r = extractJson('Sure, here it is: {"a": {"b": 2}} done.')
  assert.deepEqual(r, { a: { b: 2 } })
})

test('extractJson: 整段就是 JSON 数组', () => {
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3])
})

test('extractJson: 非 JSON 返回 undefined', () => {
  assert.equal(extractJson('完全不是 json'), undefined)
})

test('extractJson: 字符串内的括号不破坏配平', () => {
  assert.deepEqual(extractJson('{"s": "has } brace"}'), { s: 'has } brace' })
})

// ── validateSchema ───────────────────────────────────────────────

test('validateSchema: 合法对象通过', () => {
  const { ok } = validateSchema({ title: 'x', count: 3, impact: 'high' }, ITEM_SCHEMA)
  assert.ok(ok)
})

test('validateSchema: 缺必填字段报错', () => {
  const { ok, errors } = validateSchema({ title: 'x' }, ITEM_SCHEMA)
  assert.equal(ok, false)
  assert.ok(errors.some(e => /count/.test(e)))
})

test('validateSchema: 类型不符报错', () => {
  const { ok, errors } = validateSchema({ title: 'x', count: 'NaN' }, ITEM_SCHEMA)
  assert.equal(ok, false)
  assert.ok(errors.some(e => /count.*integer/.test(e)))
})

test('validateSchema: enum 越界报错', () => {
  const { ok } = validateSchema({ title: 'x', count: 1, impact: 'mid' }, ITEM_SCHEMA)
  assert.equal(ok, false)
})

test('validateSchema: additionalProperties:false 拦截额外字段', () => {
  const { ok, errors } = validateSchema({ title: 'x', count: 1, extra: 9 }, ITEM_SCHEMA)
  assert.equal(ok, false)
  assert.ok(errors.some(e => /额外字段/.test(e)))
})

test('validateSchema: 数组元素逐个校验', () => {
  const { ok } = validateSchema({ title: 'x', count: 1, tags: ['a', 2] }, ITEM_SCHEMA)
  assert.equal(ok, false)
})

// ── validateSchema: 数值 / 字符串 / 数组约束 ─────────────────────

test('validateSchema: minimum — 低于下界报错', () => {
  const { ok, errors } = validateSchema(4, { type: 'number', minimum: 5 })
  assert.equal(ok, false)
  assert.ok(errors.some(e => /minimum/.test(e)))
})

test('validateSchema: minimum — 等于下界通过', () => {
  const { ok } = validateSchema(5, { type: 'number', minimum: 5 })
  assert.ok(ok)
})

test('validateSchema: maximum — 超过上界报错', () => {
  const { ok, errors } = validateSchema(11, { type: 'integer', maximum: 10 })
  assert.equal(ok, false)
  assert.ok(errors.some(e => /maximum/.test(e)))
})

test('validateSchema: maximum — 等于上界通过', () => {
  const { ok } = validateSchema(10, { type: 'integer', maximum: 10 })
  assert.ok(ok)
})

test('validateSchema: minLength — 字符串太短报错', () => {
  const { ok, errors } = validateSchema('ab', { type: 'string', minLength: 3 })
  assert.equal(ok, false)
  assert.ok(errors.some(e => /minLength/.test(e)))
})

test('validateSchema: minLength — 满足下限通过', () => {
  const { ok } = validateSchema('abc', { type: 'string', minLength: 3 })
  assert.ok(ok)
})

test('validateSchema: maxLength — 字符串太长报错', () => {
  const { ok, errors } = validateSchema('abcde', { type: 'string', maxLength: 4 })
  assert.equal(ok, false)
  assert.ok(errors.some(e => /maxLength/.test(e)))
})

test('validateSchema: maxLength — 满足上限通过', () => {
  const { ok } = validateSchema('abcd', { type: 'string', maxLength: 4 })
  assert.ok(ok)
})

test('validateSchema: minItems — 数组太短报错', () => {
  const { ok, errors } = validateSchema([1], { type: 'array', minItems: 2 })
  assert.equal(ok, false)
  assert.ok(errors.some(e => /minItems/.test(e)))
})

test('validateSchema: minItems — 满足下限通过', () => {
  const { ok } = validateSchema([1, 2], { type: 'array', minItems: 2 })
  assert.ok(ok)
})

test('validateSchema: maxItems — 数组太长报错', () => {
  const { ok, errors } = validateSchema([1, 2, 3], { type: 'array', maxItems: 2 })
  assert.equal(ok, false)
  assert.ok(errors.some(e => /maxItems/.test(e)))
})

test('validateSchema: maxItems — 满足上限通过', () => {
  const { ok } = validateSchema([1, 2], { type: 'array', maxItems: 2 })
  assert.ok(ok)
})

// ── stubFromSchema ───────────────────────────────────────────────

test('stubFromSchema: 造出符合 schema 的占位对象', () => {
  const stub = stubFromSchema(ITEM_SCHEMA)
  assert.equal(typeof stub.title, 'string')
  assert.equal(typeof stub.count, 'number')
  const { ok } = validateSchema(stub, ITEM_SCHEMA)
  assert.ok(ok, 'stub 自身应通过校验')
})

test('stubFromSchema: minimum 约束 — stub >= minimum', () => {
  const schema = { type: 'number', minimum: 5 }
  const stub = stubFromSchema(schema)
  assert.ok(stub >= 5, `stub 应 >= 5，实际：${stub}`)
  const { ok } = validateSchema(stub, schema)
  assert.ok(ok, 'stub 应通过 minimum 约束')
})

test('stubFromSchema: integer minimum — stub 是满足下限的整数', () => {
  const schema = { type: 'integer', minimum: 3.5 }
  const stub = stubFromSchema(schema)
  assert.ok(Number.isInteger(stub), 'stub 应是整数')
  assert.ok(stub >= 3.5)
})

test('stubFromSchema: minLength — stub.length >= minLength', () => {
  const schema = { type: 'string', minLength: 4 }
  const stub = stubFromSchema(schema)
  assert.ok(stub.length >= 4, `stub.length=${stub.length} 应 >= 4`)
  const { ok } = validateSchema(stub, schema)
  assert.ok(ok)
})

test('stubFromSchema: minItems — stub.length >= minItems', () => {
  const schema = { type: 'array', minItems: 3, items: { type: 'string' } }
  const stub = stubFromSchema(schema)
  assert.equal(stub.length, 3)
  const { ok } = validateSchema(stub, schema)
  assert.ok(ok, 'stub 应通过 minItems 约束')
})

// ── runStructured ────────────────────────────────────────────────

test('runStructured: 首次即合法直接返回解析对象', async () => {
  let calls = 0
  const runner = async () => { calls++; return '```json\n{"title":"t","count":2}\n```' }
  const r = await runStructured(runner, 'do it', { schema: ITEM_SCHEMA })
  assert.deepEqual(r, { title: 't', count: 2 })
  assert.equal(calls, 1)
})

test('runStructured: 首次不合法 → 回喂错误重试一次成功', async () => {
  let calls = 0
  const runner = async (prompt) => {
    calls++
    if (calls === 1) return '不是 json'
    assert.match(prompt, /未通过校验/, '重试 prompt 应含上次错误回喂')
    return '{"title":"ok","count":1}'
  }
  const r = await runStructured(runner, 'do it', { schema: ITEM_SCHEMA })
  assert.deepEqual(r, { title: 'ok', count: 1 })
  assert.equal(calls, 2)
})

test('runStructured: 超过重试次数仍不合法 → 抛错', async () => {
  const runner = async () => '{"title":"x"}'  // 永远缺 count
  await assert.rejects(
    () => runStructured(runner, 'do it', { schema: ITEM_SCHEMA, retries: 1 }),
    (e) => {
      assert.match(e.message, /仍不符合 schema/)
      assert.ok(e instanceof SchemaError, `应为 SchemaError，实际：${e?.constructor?.name}`)
      return true
    },
  )
})

test('runStructured: 无 schema 时退化为直接 runner', async () => {
  const r = await runStructured(async () => 'plain text', 'p', {})
  assert.equal(r, 'plain text')
})

test('runStructured: dry-run 返回 stub，不调 runner', async () => {
  process.env.FLOWCAST_DRY_RUN = '1'
  try {
    let called = false
    const r = await runStructured(async () => { called = true; return 'x' }, 'p', { schema: ITEM_SCHEMA })
    assert.equal(called, false, 'dry-run 不应调真 runner')
    assert.ok(validateSchema(r, ITEM_SCHEMA).ok)
  } finally {
    delete process.env.FLOWCAST_DRY_RUN
  }
})
