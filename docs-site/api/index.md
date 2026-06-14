# API 参考 · 总览

所有对外 API 都从 `flowcast` 导出（在 `index.js` 登记）。本页是分类索引，点进各分页看完整签名。

```js
import {
  // 断点续跑
  Checkpoint,
  // Agent 执行
  runAgent, runAgentChain, setWorkdir, setAgentEventSink,
  claude, cursor, gemini, codex, aider, recursive, agy,
  spawnCapture, resolveRecursiveBin, recursiveProviderEnv, claudeProviderEnv, isProviderRetryable,
  parallel, pipeline,
  // HITL
  waitForInput, notify, setHitlBackend, getHitlBackend,
  // 质量门 / 自改沙箱
  runGate, runGates, withSelfModGuard, captureBaseline,
  // 失败上下文
  writeFailureContext, readAndConsumeFailureContext,
  // Provider / Executor
  interpolateEnv, loadProviders, resolveProvider, loadMergedConfig, basenamesFor,
  EXECUTORS, getExecutor, loadAgents, resolveAgent,
  // dry-run
  isDryRun,
  // Git
  gitStatus, gitDiff, gitCommitAll, gitHead, gitCurrentBranch,
  gitCommitsAhead, gitCreateBranch, gitWorktreeAdd, gitWorktreeRemove,
  // 子 flow
  runFlow, fanOut, archiveChildRun,
  // Dashboard
  collectRuns, renderHtml, generateDashboard,
} from 'flowcast'
```

## 分类

| 分页 | 内容 |
|------|------|
| [Checkpoint](/api/checkpoint) | 断点续跑的步骤记录 |
| [Agent 执行](/api/agent) | `runAgent` / adapter / 链式回退 / 并发 / HITL |
| [质量门 / 自改沙箱](/api/quality-gate) | `runGate` / `runGates` / `withSelfModGuard` / `captureBaseline` |
| [Provider / Executor](/api/provider-executor) | 配置加载、解析、执行器能力分层 |
| [Git / Subflow](/api/git-subflow) | 受控 git 原语 + 子 flow 调度 |
| [Dashboard](/api/dashboard) | 可观测看板采集与渲染 |

## L3 编排（orchestrator）

L3 的 API 从 `flowcast/orchestrator`（`orchestrator/index.js`）导出：

| 导出 | 作用 |
|------|------|
| `orchestrate(request, opts)` | 单 flow 端到端编排（生成→校验→执行，续跑锁定） |
| `orchestrateMulti(goal, opts)` | 接单分拆 → 每任务生成 flow → fanOut 并发 |
| `generateFlow` / `validateFlow` | 受控生成 / 跑前校验 |
| `decompose` | LLM 受控分拆大目标为子任务清单 |
| `checkFlowcastResolvable(repo)` | 预检：目标仓能否解析 `flowcast` |

用法见 [L3 编排指南](/guide/orchestration)。

::: tip dry-run
几乎所有原语都尊重 `isDryRun()`：`runAgent` / `resolveAgent` 返回假执行器，`runGate` 直接判过，`runFlow` / `fanOut` 不真正隔离。`FLOWCAST_DRY_RUN=1` 即可跑通骨架。
:::
