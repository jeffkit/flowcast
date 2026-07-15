// agent.js — 向后兼容的公共 API 聚合层
//
// v0.6 重构：adapters.js 已删除，所有执行器实现走 agentproc SDK 的 in-process executor。
//   executor.js    — runAgent 路由 + runAgentChain 回退链 + EXECUTORS 注册表 + agentEventSink
//   agentproc      — 12 个内置 executor（claude-code / codex / cursor / ...）
//   concurrency.js — 并发工具（parallel / pipeline）
//   hitl.js        — HITL 子系统
//   provider.js    — provider 配置 + provider→env 翻译器
//
// agent.js（本文件）— 纯 re-export，保持公共 API 不变，不再定义实现。

export { runAgent, runAgentChain, setWorkdir, setAgentEventSink, emitAgentEvent, AGENT_COOLDOWN_BASE_MS, AGENT_COOLDOWN_MAX_MS } from './executor.js'
export { spawnCapture, spawnCli, isProviderRetryable } from './spawn.js'
export { parallel, pipeline } from './concurrency.js'
export { setHitlBackend, getHitlBackend, waitForInput, notify } from './hitl.js'
export { resolveRecursiveBin } from './executor/recursive-extras.js'
export { claudeProviderEnv, recursiveProviderEnv, aiderProviderEnv, applyProviderToProfile } from './provider.js'