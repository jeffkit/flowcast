// flowcast 公共 API
//
// "flowcast" 表面（下游 flow 用）：以下 export。稳定契约，semver 保护。
// "flowcast/internal" 表面（测试/工具脚本用）：见 ./internal.js。无稳定性承诺。
export { Checkpoint, PauseSignal } from './checkpoint.js'
export {
  runAgent, runAgentChain, setWorkdir, setAgentEventSink,
  claude, cursor, gemini, codex, aider, recursive, agy,
  CLAUDE_DEFAULT_TIMEOUT, GEMINI_DEFAULT_TIMEOUT, CODEX_DEFAULT_TIMEOUT,
  AGY_DEFAULT_TIMEOUT, CURSOR_DEFAULT_TIMEOUT, AIDER_DEFAULT_TIMEOUT, RECURSIVE_DEFAULT_TIMEOUT,
  spawnCapture, resolveRecursiveBin, recursiveProviderEnv, claudeProviderEnv, isProviderRetryable,
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
export { assertSafeIdent, makeEvent } from './helpers.js'
export { FlowcastError, TimeoutError, SpawnError, GateError, SchemaError, ConfigError, PathError, isRetryable } from './errors.js'
