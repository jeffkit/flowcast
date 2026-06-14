# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 安全
- **`setHitlBackend('wecom', cfg)` 加固**：`cfg.mcp2cli` 必须是 `mcp2cli`（默认走 PATH）或白名单目录（`/usr/local/bin`、`/usr/bin`、`/opt/homebrew/bin` 等）下的绝对路径；`cfg.server` 必须是 `@<namespace>/<name>` 形式。防 generated flow / 配置文件注入 `/bin/sh`、`curl evil.com` 等任意 binary 的 RCE 信道。
- **`resolveAgent` 配置字段白名单**：透传给 adapter 的字段必须在 `SAFE_OPTS_KEYS` 白名单内（`cwd` / `timeout` / `model` / `maxSteps` / `allowTools` / `extraArgs` / `transcriptOut` / `pricingFile`）；白名单外字段（如 `systemPromptFile` / `workspace` 任意路径）静默丢弃。`extraArgs` 元素级白名单 `sanitizeExtraArgs` 进一步过滤 `claude` / `recursive` 已知安全 flag，锁定型执行器（`cursor` / `gemini` / `codex` / `agy`）拒绝任何 flag。
- **任务标识符白名单统一**：新增 `helpers.assertSafeIdent`，`subflow` 的 `task.name` 与 `writeFailureContext` / `readAndConsumeFailureContext` 的 `tag` 都改走此校验。防 `..` / `/` / `\` / `.` 开头等路径穿越字符。

### 新增
- 文档站（VitePress）：首页、快速上手、核心概念、L3 编排、配置分层、示例、API 参考，
  以及《从零到第一次跑通》《排错 / FAQ》《给 AI 使用》页与 `/llms.txt` 单页速查。
- `skills/flowx/SKILL.md`：随仓发布的 flowx skill，给"使用 flowx 的 AI"一份触发词 +
  最小 bootstrap + 能力词汇表 + 排错对照 + 决策树。
- 发布脚手架：`.github/workflows/publish.yml`（打 `v*` tag → `npm publish --provenance`）。
- `Checkpoint.setLoopState / getLoopState / countCompletedTurns / setExpectMaxMs`：loop 原语协作的窄接口。`loop.js` 不再直接读写 `cp.state.loopXxx`。
- `subflow.sweepStaleTmp(baseDir)`：扫 tmpdir 清理 1h+ 前的 `flowx-codex-*` 与 failure-context sidecar，给 `bin/flowx.js` 启动时调用。
- `orchestrator/run` 在 `orchestrateMulti` 调 `fanOut` 时自动传 `onResult` 调 `archiveChildRun`，worktree 隔离下子 run 自动归档到主仓 `.flowx/runs/`（dashboard 父子链显式接通）。

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
  - `dirs.js` 在 `FLOWCAST_DRY_RUN=1` 时把 `flowcastDir()` 重定向到 `~/.flowx/dryrun/`，所有原语自动跟随。
- **subflow 资源批**：
  - `runFlow` 收 SIGINT / SIGTERM 时主动转发给子进程，避免父死子变孤儿。
  - `spawnCapture` / `spawnCli` 超时改 SIGTERM + 5s 后 SIGKILL 兜底。
  - `spawnCli` 加 `proc.on('error')` reject（ENOENT / EACCES 不再 hang）。
  - `Checkpoint.error` 分支不再静默丢 `cli / model / inputTokens / outputTokens` 元数据（保留供看板汇总）。
- **dry-run 清洁**：`FLOWCAST_DRY_RUN=1` 时所有通过 `flowcastDir()` 派生的状态（memory / failure-context / orchestrator）写到 `~/.flowx/dryrun/`，与真盘隔离。
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
  CLI `flowx orchestrate [--split]`，护栏三件套（约束式生成 / 跑前校验 / 持久化+续跑锁定）。
- **可观测看板**：`collectRuns` / `renderHtml` / `generateDashboard`，CLI `flowx dashboard`。

[Unreleased]: https://github.com/jeffkit/flowx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jeffkit/flowx/releases/tag/v0.1.0
