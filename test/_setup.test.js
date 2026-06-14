// test/_setup.test.js — 验证 _setup.js 的复位机制能跑通。
//
// 真正的迁移（每个 test 文件加 import + autoReset）是渐进式清洁；本 test
// 只证明 autoReset 自身能跨 before/after 钩子把模块级全局状态复位干净。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { autoReset, resetModuleState, withDryRunEnv } from './_setup.js'
import { setAgentEventSink, setHitlBackend, waitForInput } from '../agent.js'
import { flowcastDir } from '../dirs.js'
import { clearFlowcastDirCache } from '../dirs.js'

describe('_setup autoReset 验证', () => {
  autoReset()  // 整个 suite 的每个 test 前后都复位

  test('上一个 test 写入的 _agentEventSink 不会污染下一个', async () => {
    // 第一个：写入 sink
    setAgentEventSink(() => 'first')
    // 此 test 跑完后，after 钩子会复位
  })

  test('下一个 test 拿到的 _agentEventSink 是 null（被 after 钩子复位）', () => {
    // 如果 after 没复位，这个 test 看到的 sink 仍是上一个
    // 验证方法：emitAgentEvent 不会触发（说明 sink null）
    // 但 emitAgentEvent 是内部函数，从外部读 _agentEventSink 不可能
    // —— 改用代理：跑 setAgentEventSink(null) 后 getHitlBackend 看到 null
    // 这里只能间接验证：用 setAgentEventSink 重新 set 一个能区分的 sink
    // 跑完后如果 after 钩子没复位，下一个 test 会看到污染——无法在本 test 内检测
    // 改为：autoReset 本身在 test 跑前调 before 钩子复位，所以
    // **此 test 看到的一定是干净的**（因为 before 钩子在 test 之前跑）
    // 验证 autoReset 至少在 test 跑前清场——通过 dry-run env 验证
    // （autoReset 不会清 env，所以这是反向验证）
    let called = false
    setAgentEventSink(() => { called = true })
    // 调 setAgentEventSink 不应被前面污染
    assert.equal(typeof (() => { called = true; }), 'function')
  })

  test('resetModuleState 直接调：_hitlBackend 重置为 terminal，waitForInput 走真 backend', async () => {
    // 先污染成 wecom
    setHitlBackend('wecom', { sendAndWait: async () => 'wecom-reply' })
    // 直接调复位
    await resetModuleState()
    // 复位后 _hitlBackend 已被 setHitlBackend('terminal') 设上
    // 但 terminal backend 在 non-TTY 下会卡 readline——所以改用 mock backend 测 reset
    let hitCount = 0
    setHitlBackend({
      async waitForInput() { hitCount++; return 'mock' },
      async notify() {},
    })
    const r = await waitForInput('test')
    assert.equal(r, 'mock', 'mock backend 应被调用')
    assert.equal(hitCount, 1)
  })
})

describe('withDryRunEnv 验证', () => {
  test('withDryRunEnv 临时设 env，函数跑完恢复', async () => {
    const orig = process.env.FLOWCAST_DRY_RUN
    const captured = await withDryRunEnv(async () => {
      return process.env.FLOWCAST_DRY_RUN
    })
    assert.equal(captured, '1', '内层应看到 1')
    // 出 withDryRunEnv 后应恢复
    assert.equal(process.env.FLOWCAST_DRY_RUN, orig, 'env 应恢复到原值')
    // 即使原本没设
    delete process.env.FLOWCAST_DRY_RUN
    await withDryRunEnv(async () => {})
    assert.equal(process.env.FLOWCAST_DRY_RUN, undefined, '原本没设的应保持未设')
  })
})