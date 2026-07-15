// flowcast 公共 API
//
// "flowcast" 表面（下游 flow 用）：以下 export。稳定契约，semver 保护。
// "flowcast/internal" 表面（测试/工具脚本用）：见 ./internal.js。无稳定性承诺。
//
// v0.6：adapters.js 已删除。CLI adapter（claude/cursor/gemini/codex/...）由 agentproc SDK 提供，
// 通过 agentproc.run 内部调用。用户调 flowcast 时不再需要直接 import adapter 函数。
export { EVENT, EVENT_TYPES, listEventTypes } from './events.js'
export { Checkpoint } from './checkpoint.js'
export {
  runAgent, runAgentChain, setWorkdir, setAgentEventSink,
  spawnCapture, spawnCli, resolveRecursiveBin, recursiveProviderEnv, claudeProviderEnv, aiderProviderEnv, applyProviderToProfile, isProviderRetryable,
  emitAgentEvent,
  parallel, pipeline,
  waitForInput, notify, setHitlBackend, getHitlBackend,
} from './agent.js'
export { withSelfModGuard, captureBaseline } from './self-mod-guard.js'
export { runGate, runGates, loadGates, mergeGates } from './quality-gate.js'
export { validateSchema, runStructured } from './schema.js'
export { verifyAdversarial } from './verify.js'
export { writeFailureContext, readAndConsumeFailureContext } from './failure-context.js'
export { recordLearning, recall, buildMemorySection, promoteFailureContext } from './memory.js'
export { loop } from './loop.js'
export { interpolateEnv, loadProviders, resolveProvider, loadMergedConfig, basenamesFor } from './provider.js'
export { EXECUTORS, getExecutor, loadAgents, resolveAgent, registerExecutor } from './executor.js'
export { isDryRun } from './dry-run.js'
export { flowcastDir } from './dirs.js'  // 内部 helper 见 ./internal.js
export { gitStatus, gitDiff, gitCommitAll, gitHead, gitCurrentBranch, gitCommitsAhead, gitCreateBranch, gitWorktreeAdd, gitWorktreeRemove } from './git.js'
export { runFlow, fanOut, archiveChildRun } from './subflow.js'  // sweepStaleTmp 是内部工具，从 flowcast/internal 导出
export { collectRuns, renderHtml, generateDashboard } from './dashboard/index.js'
export { assertSafeIdent, makeEvent, makeAgentResult, agentText, agentMeta } from './helpers.js'
export { FlowcastError, TimeoutError, SpawnError, GateError, SchemaError, ConfigError, PathError, LockError, GitError, ParallelError, VerifyError, GuardError, PauseSignal, isRetryable } from './errors.js'
export { recordRateLimit, getAvailableAt, isAvailable, listRateLimits, clearRateLimit, matchPattern, analyzeWithLLM, listPatterns, removePattern, makeKey } from './rate-limiter.js'
