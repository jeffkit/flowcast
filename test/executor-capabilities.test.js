// executor-capabilities.test.js — 执行器能力协商（fail before spawn）
//
// borrow 自 dsh subagent provider 的 capabilities 设计（见
// docs/NOTES-dsh-workflow-borrowings.md 第 5 条）：
//   - registerExecutor 声明 capabilities（未声明 = 全不支持，保守缺省）
//   - getExecutor 返回归一化 capabilities
//   - resolveAgent / runAgent 请求 hard 能力（permission）而执行器不支持
//     → spawn 之前抛 ConfigError，错误信息带支持者列表

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXECUTORS, getExecutor, registerExecutor, resolveAgent,
} from '../executor.js'
import { ConfigError } from '../errors.js'
import { setWorkdir } from '../agent.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowcast-caps-')) }

test('getExecutor: 内置 claude-code 声明 permission/streaming/sessionResume', () => {
  const ex = getExecutor('claude')
  assert.equal(ex.capabilities.permission, true)
  assert.equal(ex.capabilities.streaming, true)
  assert.equal(ex.capabilities.sessionResume, true)
})

test('getExecutor: 内置 deepseek 全不支持（保守）', () => {
  const ex = getExecutor('deepseek')
  assert.deepEqual(ex.capabilities, { streaming: false, permission: false, sessionResume: false })
})

test('getExecutor: 未列入能力表的执行器得到保守缺省', () => {
  registerExecutor('caps-unknown-cli', async () => 'ok')
  const ex = getExecutor('caps-unknown-cli')
  assert.equal(ex.capabilities.permission, false)
  assert.equal(ex.capabilities.sessionResume, false)
})

test('registerExecutor: capabilities 显式声明 + 类型校验', () => {
  registerExecutor('caps-declared', async () => 'ok', {
    capabilities: { permission: true, sessionResume: true },
  })
  const ex = getExecutor('caps-declared')
  assert.equal(ex.capabilities.permission, true)
  assert.equal(ex.capabilities.streaming, false)  // 未声明 → 不支持
  assert.equal(ex.capabilities.sessionResume, true)

  assert.throws(
    () => registerExecutor('caps-bad', async () => 'ok', { capabilities: { permission: 'yes' } }),
    /capabilities\.permission 必须是 boolean/,
  )
})

test('resolveAgent: 请求 permission 而执行器不支持 → spawn 前抛 ConfigError（带指引）', () => {
  const agents = {
    'locked-agent': { executor: 'deepseek', permission: true },
  }
  assert.throws(
    () => resolveAgent('locked-agent', agents),
    (e) => {
      assert.ok(e instanceof ConfigError)
      assert.match(e.message, /permission: true/)
      assert.match(e.message, /claude/)  // 支持者列表给出可用执行器
      return true
    },
  )
})

test('resolveAgent: 支持能力的执行器请求 permission → 通过，且透传到 opts', () => {
  const agents = {
    'permed-agent': { executor: 'claude', permission: true },
  }
  const { opts } = resolveAgent('permed-agent', agents)
  assert.equal(opts.permission, true)
})

test('runAgent: 直调路径的能力校验与 resolveAgent 对称', async () => {
  const dir = tempDir()
  setWorkdir(dir)
  try {
    await assert.rejects(
      () => import('../agent.js').then(m => m.runAgent('hi', { cli: 'deepseek', permission: true })),
      (e) => {
        assert.ok(e instanceof ConfigError)
        assert.match(e.message, /permission: true/)
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EXECUTORS 注册表：能力表条目挂载在 entry 上', () => {
  assert.equal(EXECUTORS['claude'].capabilities.permission, true)
  assert.equal(EXECUTORS['dsh']?.capabilities.sessionResume, true)
})
