// agent.js — 向后兼容的公共 API 聚合层
//
// 职责拆分（P1-A1 循环依赖修复后）：
//   adapters.js    — CLI adapter 实现（claude/cursor/…/recursive）+ 可观测事件 sink
//   spawn.js       — 底层进程原语（spawnCapture / spawnCli / isProviderRetryable / sweepStaleTmp）
//   concurrency.js — 并发工具（parallel / pipeline）
//   hitl.js        — HITL 子系统（setHitlBackend / waitForInput / notify …）
//   executor.js    — runAgent 路由 + runAgentChain 回退链 + EXECUTORS 注册表
//   agent.js（本文件）— 纯 re-export，保持公共 API 不变，不再定义实现
//
// 旧循环：executor.js ←imports adapters← agent.js ←re-exports← executor.js
// 新链路：executor.js ←imports← adapters.js（无循环）
//         agent.js ←re-exports← adapters.js + executor.js（无循环）

// 全部 adapter 实现从 adapters.js re-export（单一事实来源）
export {
  claude, cursor, gemini, codex, aider, recursive, agy,
  resolveRecursiveBin, recursiveProviderEnv, claudeProviderEnv, claudeApplyProvider,
  setAgentEventSink, emitAgentEvent,
  CLAUDE_DEFAULT_TIMEOUT, GEMINI_DEFAULT_TIMEOUT, CODEX_DEFAULT_TIMEOUT,
  AGY_DEFAULT_TIMEOUT, CURSOR_DEFAULT_TIMEOUT, AIDER_DEFAULT_TIMEOUT, RECURSIVE_DEFAULT_TIMEOUT,
} from './adapters.js'

// spawn / concurrency / hitl 的 re-export（保持旧 API 路径 agent.js 可用）
export { spawnCapture, spawnCli, isProviderRetryable } from './spawn.js'
export { parallel, pipeline } from './concurrency.js'
export { setHitlBackend, getHitlBackend, waitForInput, notify } from './hitl.js'

// 路由层（实现在 executor.js）
export { runAgent, runAgentChain, setWorkdir, AGENT_COOLDOWN_BASE_MS, AGENT_COOLDOWN_MAX_MS } from './executor.js'
