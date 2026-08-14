// executor/dsh.js — dsh executor 描述符 + agentproc 兼容注入
//
// dsh（DeepSeek Harness）headless 是一次性完整 agent 运行时（coding persona +
// bash/fs/search 工具 + 沙箱 + 持久化 session log），stdout 是最后一条非空
// assistant 消息，错误走 stderr + 非零退出 —— plain 语义。
//
// 为什么存在这个文件：agentproc SDK >= 0.11（待发布）原生收录 'dsh' executor；
// 在此之前，flowcast 依赖的 npm 版 agentproc（0.10.x）的 EXECUTORS 表里没有它，
// runner 会对未知 executor 硬失败。ensureDshExecutor() 在加载时把描述符注入
// agentproc.EXECUTORS（同一模块实例，runner 的查找随之可见）；SDK 原生收录后
// guard 直接跳过，此文件自然退役。
//
// 无人值守权限：dsh 默认 approval 策略是 "ask"（无 UI 应答会挂起），由
// agentproc-adapter.js 的 buildAgentProcProfile 统一注入
// DSH_PERMISSION_MODE=danger-full-access 默认值（与 agentproc hub 的 dsh
// profile 同惯例）。

import agentproc from 'agentproc'

/** dsh executor 描述符（与 agentproc SDK src/executors.js 的 'dsh' 保持一致）。 */
export const dshExecutor = {
  cliName: 'dsh',
  installHint: 'Install: npm install -g @deepseek-ai/dsh',
  plain: true,

  buildArgs(message) {
    return ['dsh', '--profile', 'headless', message]
  },
}

/**
 * 确保 agentproc EXECUTORS 注册表里有 'dsh'。
 *
 * - SDK 已原生收录（>= 0.11）：no-op，用 SDK 的版本（单一事实来源）。
 * - SDK 未收录（0.10.x）：注入本地描述符。EXECUTORS 是普通可变对象，
 *   runner.js 通过 require('./executors.js') 拿到同一实例，注入后立即可见。
 */
export function ensureDshExecutor() {
  if (agentproc.EXECUTORS && !('dsh' in agentproc.EXECUTORS)) {
    agentproc.EXECUTORS.dsh = dshExecutor
    return true // injected
  }
  return false // native
}
