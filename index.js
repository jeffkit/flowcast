// flowcast 公共 API
//
// "flowcast" 表面（下游 flow 用）：以下 export。稳定契约，semver 保护。
// "flowcast/internal" 表面（测试/工具脚本用）：见 ./internal.js。无稳定性承诺。
export { Checkpoint, PauseSignal } from './checkpoint.js'
export {
  runAgent, runAgentChain, setWorkdir, setAgentEventSink,
  claude, cursor, gemini, codex, aider, recursive, agy,
  spawnCapture, resolveRecursiveBin, recursiveProviderEnv, claudeProviderEnv, isProviderRetryable,
  parallel, pipeline,
  waitForInput, notify, setHitlBackend, getHitlBackend,
} from './agent.js'
export { withSelfModGuard, captureBaseline } from './self-mod-guard.js'
export { runGate, runGates } from './quality-gate.js'
export { writeFailureContext, readAndConsumeFailureContext } from './failure-context.js'
export { recordLearning, recall, buildMemorySection, promoteFailureContext } from './memory.js'
export { loop } from './loop.js'
export { interpolateEnv, loadProviders, resolveProvider, loadMergedConfig, basenamesFor } from './provider.js'
export { EXECUTORS, getExecutor, loadAgents, resolveAgent, registerExecutor } from './executor.js'
export { isDryRun } from './dry-run.js'
export { flowcastDir } from './dirs.js'  // 内部 helper 见 ./internal.js
export { gitStatus, gitDiff, gitCommitAll, gitHead, gitCurrentBranch, gitCommitsAhead, gitCreateBranch, gitWorktreeAdd, gitWorktreeRemove } from './git.js'
export { runFlow, fanOut, archiveChildRun } from './subflow.js'  // 内部 helper 见 ./internal.js
export { collectRuns, renderHtml, generateDashboard } from './dashboard/index.js'
export { assertSafeIdent } from './helpers.js'
