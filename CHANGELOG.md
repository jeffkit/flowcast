# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-06-14

### 变更
- **品牌与仓库重命名 FlowX → FlowCast**：GitHub 仓库 `jeffkit/flowx` → `jeffkit/flowcast`；文档站 base `/flowcast/`；CLI 入口 `bin/flowcast.js`；`skills/flowcast/`；`checkFlowcastResolvable`（原 `checkFlowxResolvable`）；dry-run 根目录 `~/.flowcast/dryrun/`；codex 临时文件前缀 `flowcast-codex-*`。
- **向后兼容保留**：CLI 别名 `flowx`；数据目录 `.flowx/` fallback；环境变量 `FLOWX_DRY_RUN` / `FLOWX_AGENT_COOLDOWN_*` / `FLOWX_PKG_INDEX`；legacy tmp 前缀 `flowx-codex-*` 仍会被 sweep。

### 破坏性变更

> **本节面向**通过 `file:` 依赖或 npm 安装消费 flowcast 的下游仓（如 recursive / ilink-hub）。
> 升级前请通读本节并相应更新代码。

- **`executor.js` 删除 `claudeApply` / `recursiveApply` 翻译器函数**。
  `applyProvider` 现在挂在 adapter 自身（`claude.applyProvider = claudeApplyProvider`、`recursive.applyProvider = recursiveProviderEnv`、`aider.applyProvider = aiderApply`）。下游若 `import { claudeApply } from 'flowcast/executor.js'` 会直接断——改 import `claudeApplyProvider` from `'flowcast/agent.js'`，或在 `agents.json` 改用标准 provider 字段（`resolveAgent` 自动接）。
- **`setHitlBackend` 默认值从 `terminalBackend` 改为 `null`**。
  未调 `setHitlBackend` 时 `waitForInput` / `notify` 抛清晰错误（不再静默用 terminal 在非 TTY 卡死）。下游若依赖「未配 backend 就走 terminal」的隐式行为，必须显式 `setHitlBackend('terminal')` 启动。
- **`claude` adapter 注入的 env 变量名从 `ANTHROPIC_API_KEY` 统一为 `ANTHROPIC_AUTH_TOKEN`**。
  旧 `executor.claudeApply` 写 `ANTHROPIC_API_KEY`；新 `claudeApplyProvider`（adapter 自带）写 `ANTHROPIC_AUTH_TOKEN`（Claude Code CLI 实际读取的字段）。下游若依赖 `process.env.ANTHROPIC_API_KEY`（不是从 spawn 来的而是 ambient），行为不变——但如果通过 `runProfile` + provider 注入，env 注入字段改了。
- **`agent.js` 删除 `notify` 的「backend 无 notify 回退 terminal」兜底**。
  旧版 `notify` 会在 `_hitlBackend` 缺 `notify` 方法时退到 `terminalBackend.notify`（`console.log`）。新版抛错（"HITL 后端未配置"）或调 backend.notify。必须给所有走 `notify` 的 backend 显式提供 `notify` 方法。
- **`claudeProviderEnv` 不再 fail-fast 拒绝非 `anthropic` 类型 provider**。
  旧版 `claudeProviderEnv({type: 'openai'})` 抛错；新版接受任何 type（Claude Code CLI 网关可转发多协议）。下游客服端若依赖"非 anthropic type 拒绝"的旧行为需要自行加检查。
- **新增 `flowcast/internal` 子路径**（见变更节），下游不应 import 此路径（内部 helper，仅供测试 / 工具脚本）。

### 安全
- **`setHitlBackend('wecom', cfg)` 加固**：`cfg.mcp2cli` 必须是 `mcp2cli`（默认走 PATH）或白名单目录（`/usr/local/bin`、`/usr/bin`、`/opt/homebrew/bin` 等）下的绝对路径；`cfg.server` 必须是 `@<namespace>/<name>` 形式。防 generated flow / 配置文件注入 `/bin/sh`、`curl evil.com` 等任意 binary 的 RCE 信道。
- **`resolveAgent` 配置字段白名单**：透传给 adapter 的字段必须在 `SAFE_OPTS_KEYS` 白名单内（`cwd` / `timeout` / `model` / `maxSteps` / `allowTools` / `extraArgs` / `transcriptOut` / `pricingFile`）；白名单外字段（如 `systemPromptFile` / `workspace` 任意路径）静默丢弃。`extraArgs` 元素级白名单 `sanitizeExtraArgs` 进一步过滤 `claude` / `recursive` 已知安全 flag，锁定型执行器（`cursor` / `gemini` / `codex` / `agy`）拒绝任何 flag。
- **任务标识符白名单统一**：新增 `helpers.assertSafeIdent`，`subflow` 的 `task.name` 与 `writeFailureContext` / `readAndConsumeFailureContext` 的 `tag` 都改走此校验。防 `..` / `/` / `\` / `.` 开头等路径穿越字符。

### 新增
- 文档站（VitePress）：首页、快速上手、核心概念、L3 编排、配置分层、示例、API 参考，
  以及《从零到第一次跑通》《排错 / FAQ》《给 AI 使用》页与 `/llms.txt` 单页速查。
- `skills/flowcast/SKILL.md`：随仓发布的 flowcast skill，给"使用 flowcast 的 AI"一份触发词 +
  最小 bootstrap + 能力词汇表 + 排错对照 + 决策树。
- 发布脚手架：`.github/workflows/publish.yml`（打 `v*` tag → `npm publish --provenance`）。
- `Checkpoint.setLoopState / getLoopState / countCompletedTurns / setExpectMaxMs`：loop 原语协作的窄接口。`loop.js` 不再直接读写 `cp.state.loopXxx`。
- `subflow.sweepStaleTmp(baseDir)`：扫 tmpdir 清理 1h+ 前的 `flowcast-codex-*` 与 failure-context sidecar，给 `bin/flowcast.js` 启动时调用。
- `orchestrator/run` 在 `orchestrateMulti` 调 `fanOut` 时自动传 `onResult` 调 `archiveChildRun`，worktree 隔离下子 run 自动归档到主仓 `.flowcast/runs/`（dashboard 父子链显式接通）。

### 变更
- **数据安全批**：
  - `self-mod-guard.withSelfModGuard` 的 `rollback` 改两步原子（`git reset --hard` 必先成功才 `git clean -fd`），末尾 `git status --porcelain` 校验；失败 throw 而非 `console.error` 吞错；fn 抛错路径下 rollback 失败用 `Error.cause` 链式保留原 err。
  - `orchestrator/run` 续跑锁改 `mkdir` 锁目录 + `owner.json`（PID + startedAt），替换旧 O_EXCL 0-byte 文件方案（合法中间态不再被误判为僵尸）；stale 判定看 PID 是否活 + createdAt 是否超 1h。
  - `Checkpoint._flush` 改 `writeFile + renameSync` 原子写，删 `.bak` 生成（保留 `.bak` 恢复兜底兼容旧版升级）。
  - `failure-context.readAndConsumeFailureContext` 跨进程加 PID owner sidecar：rename 后写 `<p>.consuming.<pid>.owner.<pid>`，读侧短暂等待（≤50ms）后读正文，finally 清 tmp + owner。
- **架构叙事批**：
  - `executor.js` 删除 `claudeApply` / `recursiveApply` 双翻译器实现，统一指向 `agent.js` 的 `claudeApplyProvider` / `recursiveProviderEnv`，避免双实现漂移。`claudeProviderEnv` 去掉 `type !== 'anthropic'` 校验（claude CLI 网关可转发多协议）。
  - `_hitlBackend` 默认值从 `terminalBackend` 改为 `null`，`waitForInput` / `notify` 未配置 backend 时抛清晰错误（不再静默用 terminal 在非 TTY 卡死）。
  - `dashboard/collect` 父子关系优先读 `state.parentRunId` 显式字段，无字段时 fallback 到 prefix 启发式（兼容旧 run），结果带 `parentIdSource` 标记。
  - `dashboard/collect` zombie 阈值改自适应：读 `state.expectMaxMs` 拉长阈值（loop 长跑场景），超过才判 stale。
  - `validate.js` 新增 `flowcast/dashboard` 子路径黑名单（dashboard 是宿主观测，不该被编排对象自循环）。
  - `dirs.js` 在 `FLOWCAST_DRY_RUN=1` 时把 `flowcastDir()` 重定向到 `~/.flowcast/dryrun/`，所有原语自动跟随。
- **subflow 资源批**：
  - `runFlow` 收 SIGINT / SIGTERM 时主动转发给子进程，避免父死子变孤儿。
  - `spawnCapture` / `spawnCli` 超时改 SIGTERM + 5s 后 SIGKILL 兜底。
  - `spawnCli` 加 `proc.on('error')` reject（ENOENT / EACCES 不再 hang）。
  - `Checkpoint.error` 分支不再静默丢 `cli / model / inputTokens / outputTokens` 元数据（保留供看板汇总）。
- **dry-run 清洁**：`FLOWCAST_DRY_RUN=1` 时所有通过 `flowcastDir()` 派生的状态（memory / failure-context / orchestrator）写到 `~/.flowcast/dryrun/`，与真盘隔离。
- **dashboard zombie 边界**：`state` 文件 `mtime` 拿不到（stat 异常）→ `orphanedStateFile=true` 显式判 zombie，区别于「超阈值才 stale」。
- **failure-context 清洁**：删除 50ms busy-wait 死循环（owner sidecar 写盘是同步的，循环是 CPU 自旋零行为）；删除未使用的 `existsSync` import。

### 修复
- 多个长跑递归场景下被误判为僵尸（自适应阈值）。
- subflow 默认 worktree 隔离下子 run 状态未归档到主仓（自动 `archiveChildRun`）。
- 跨进程同时 `readAndConsumeFailureContext` 时输方无法区分「未写」与「被抢」（PID sidecar 显式声明所有权）。
- SIGKILL 父进程后子 flow 残留 lockDir 1h 内阻塞相同 runId 复用（mkdir-based 锁 + PID 检测）。
- 父子 run 关系靠 runId 启发式误判（`drain` 与 `drain-q3` 被错配为父子）；改用显式 `state.parentRunId` 字段。

### 测试 / 内部
- 新增 `test/_setup.js` 与 `test/_setup.test.js`：公共测试 fixture（`autoReset` / `withDryRunEnv` / `resetModuleState`）。后续新 test 文件可选用，旧文件的手写 `finally` 复位保留作为双保险。
- 测试覆盖新增：self-mod-guard 错误链、orchestrator 僵尸锁 / 活锁、checkpoint flush 原子写、failure-context 并发 reader、subflow 信号透传、dashboard 自适应阈值 / 显式父子、extraArgs 字段白名单、failure-context tag 路径穿越。

## [0.1.0]

首个版本。

### 新增
- **L2 引擎原语**：`Checkpoint`（断点续跑）、`withSelfModGuard` / `captureBaseline`（自改安全沙箱）、
  `runGate` / `runGates`（质量门）、`writeFailureContext`（失败上下文）、可插拔 HITL（terminal / wecom）、`isDryRun`。
- **L1 执行器**：`runAgent` + claude / cursor / gemini / codex / aider / recursive / agy adapter；
  `runAgentChain`（跨 CLI 限额回退 + 自适应冷却）；`parallel` / `pipeline`。
- **配置分层**：`provider.js`（`${VAR}` 插值 + 多层加载 + `resolveProvider`）、
  `executor.js`（执行器能力分层 + `resolveAgent` 绑定校验）。
- **受控 git 原语**：`gitStatus` / `gitDiff` / `gitCommitAll` / `gitCreateBranch` / `gitWorktreeAdd` / `gitWorktreeRemove` 等。
- **子 flow 调度**：`runFlow`（隔离子进程）、`fanOut`（限并发 + worktree 隔离 + per-task 日志 + 汇总）。
- **L3 codegen 编排**：`orchestrate` / `orchestrateMulti`、`generateFlow` / `validateFlow`、`decompose`，
  CLI `flowcast orchestrate [--split]`，护栏三件套（约束式生成 / 跑前校验 / 持久化+续跑锁定）。
- **可观测看板**：`collectRuns` / `renderHtml` / `generateDashboard`，CLI `flowcast dashboard`。

[Unreleased]: https://github.com/jeffkit/flowcast/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jeffkit/flowcast/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffkit/flowcast/releases/tag/v0.1.0
