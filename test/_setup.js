// test/_setup.js — 测试公共 fixture：模块级状态复位
//
// 背景：Node test runner 共享 process；agent.js 的 _agentEventSink / _hitlBackend
// 和 dirs.js 的 _cache 都是模块级全局状态。任意一个 test 漏掉 finally 复位
// 会污染后续 test。手动 finally 复位易遗漏。
//
// 用法 1：包整个文件所有 test 到一个 suite 里：
//   import { describe, test } from 'node:test'
//   import { autoReset } from './_setup.js'
//   describe('xxx.test.js', () => {
//     autoReset()           // 注册 before/after 钩子
//     test('a', () => ...)
//     test('b', () => ...)
//   })
//
// 用法 2：临时设 FLOWCAST_DRY_RUN（用完自动复原）：
//   const captured = await withDryRunEnv(async () => process.env.FLOWCAST_DRY_RUN)
//   assert.equal(captured, '1')

import { before, after, describe } from 'node:test'
import { clearFlowcastDirCache } from '../dirs.js'

/**
 * 把模块级全局状态复位到「干净测试起点」。
 * - dirs.js _cache 清空
 * - agent.js _agentEventSink = null
 * - agent.js _hitlBackend = 'terminal'
 */
export async function resetModuleState() {
  clearFlowcastDirCache()
  const { setAgentEventSink, setHitlBackend } = await import('../agent.js')
  setAgentEventSink(null)
  setHitlBackend('terminal')
}

/**
 * 在当前 suite 注册 before/after 钩子：每个 test 跑前自动复位。
 * 必须在 describe() 回调内调用（Node test runner 的 before/after 是 suite-scoped）。
 */
export function autoReset() {
  before(async () => {
    await resetModuleState()
  })
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

/**
 * 便捷：把传入的 suiteFn 包到 describe('<filename>', ...) 内并附加 autoReset。
 * 用法（替换散落的 test() 为包到 suite 里）：
 *   import { test } from 'node:test'
 *   import { autoResetSuite, fileName } from './_setup.js'
 *   autoResetSuite(fileName(import.meta.url), () => {
 *     test('a', ...)
 *   })
 */
export function autoResetSuite(suiteName, suiteFn) {
  describe(suiteName, () => {
    autoReset()
    suiteFn()
  })
}

/** 从 import.meta.url 提取文件名（不含路径）作为 suite 名。 */
export function fileName(url) {
  const m = url.match(/([^/\\]+)$/)
  return m ? m[1] : 'suite'
}