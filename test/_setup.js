// test/_setup.js — 测试公共 fixture：模块级状态复位
//
// 背景：Node test runner 共享 process；agent.js 的 _agentEventSink / _hitlBackend
// 和 dirs.js 的 _cache 都是模块级全局状态。任意一个 test 漏掉 finally 复位
// 会污染后续 test。手动 finally 复位易遗漏。
//
// 用法（test 文件第一行）：
//   import { setup, teardown } from './_setup.js'
//   setup()   // 立刻复位 + 注册 beforeEach
//   teardown()
// 或更简单：
//   import { autoReset } from './_setup.js'
//   autoReset()

import { before, after } from 'node:test'
import { clearFlowcastDirCache, flowcastDir } from '../dirs.js'
import { isDryRun } from '../dry-run.js'

// 暴露 agent.js 的 reset API（通过 setAgentEventSink(null) / setHitlBackend('terminal')）
// 已有 setter 直接调即可；这里抽公共 reset 函数。

/**
 * 把模块级全局状态复位到「干净测试起点」。
 * - dirs.js _cache 清空
 * - agent.js _agentEventSink = null
 * - agent.js _hitlBackend = null（强制每个 test 显式 setHitlBackend，避免静默 terminal）
 *
 * 也清掉 FLOWCAST_DRY_RUN env 痕迹——某些 test 会临时 set 然后没清。
 */
export function resetModuleState() {
  clearFlowcastDirCache()
  // 走显式 setter（agent.js 提供）
  // 动态 import 避免循环依赖（_setup 引入 agent 但 agent 不引入 _setup）
  return import('../agent.js').then(({ setAgentEventSink, setHitlBackend }) => {
    setAgentEventSink(null)
    setHitlBackend('terminal')
  })
}

/**
 * 在当前 test 文件里启用自动复位：每个 test 跑前都执行 resetModuleState。
 * 在 test 文件顶层调一次即可。
 */
export function autoReset() {
  before(async () => {
    await resetModuleState()
  })
  // after 也跑一次保险（万一某 test 在 before 之前写入了状态）
  after(async () => {
    await resetModuleState()
  })
}

/**
 * 临时设 FLOWCAST_DRY_RUN=1，fn 跑完恢复。给需要 dry-run 但不污染其他 test 的场景用。
 */
export async function withDryRunEnv(fn) {
  const orig = process.env.FLOWCAST_DRY_RUN
  process.env.FLOWCAST_DRY_RUN = '1'
  clearFlowcastDirCache()
  try {
    return await fn()
  } finally {
    if (orig === undefined) delete process.env.FLOWCAST_DRY_RUN
    else process.env.FLOWCAST_DRY_RUN = orig
    clearFlowcastDirCache()
  }
}