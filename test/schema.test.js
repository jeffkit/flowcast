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

// ── stubFromSchema ───────────────────────────────────────────────

test('stubFromSchema: 造出符合 schema 的占位对象', () => {
  const stub = stubFromSchema(ITEM_SCHEMA)
  assert.equal(typeof stub.title, 'string')
  assert.equal(typeof stub.count, 'number')
  const { ok } = validateSchema(stub, ITEM_SCHEMA)
  assert.ok(ok, 'stub 自身应通过校验')
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
