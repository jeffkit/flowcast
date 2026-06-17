# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-06-17

### 破坏性变更
- **`concurrency.js` `parallel()` 默认 `strict` 改为 `true`**：原默认 `strict=false` 会静默将失败任务替换为 `null` 返回，容易掩盖错误。新默认 `strict=true` 使任何一个任务失败都会抛出聚合错误（`err.failures` 含各失败任务的下标和原始 error），与 `Promise.all` 语义对齐。如需恢复旧行为，显式传 `{ strict: false }`。

### 新增
- **`test/concurrency.test.js` 独立测试文件**：将 `parallel` / `pipeline` 测试从 `test/agent.test.js` 迁出，新增 `parallel: strict=false + onError` 回调、`parallel: 空数组`、`pipeline: concurrency` 等补充用例，共 12 个测试。
- **`orchestrator/validate.js` 注释误报修复**：新增 `stripComments()` 函数，在 import 白名单扫描前先剥离行注释（`// ...`）和块注释（`/* ... */`），消除 JSDoc 示例代码中写 `import ... from 'fs'` 时被误报为违规 import 的假阳性。
- **`executor.js` `--workspace` 路径遍历防护**：`sanitizeExtraArgs` 新增 `PATH_FLAGS`（`--workspace`）和 `isSafePath()` 校验。通过 agent profile `extraArgs` 注入的 `--workspace` 值若含绝对路径（`/etc`）或路径遍历（`../../`），现在会被静默丢弃而不是透传给 recursive CLI，消除潜在的目录逃逸攻击面。

### 优化
- **`subflow.js` stdout/stderr 缓冲区上限 16MB**：`runFlow` 在不指定 `logFile` 时将无限累积子进程输出到内存，verbose 子 flow 可能导致宿主 OOM。现在与 `spawn.js` 对齐，超出 16MB 后截断并追加 `[output truncated]` 标记。
- **`checkpoint.js` 日志写入异步化**：`_log()` 从同步 `appendFileSync` 改为异步 `appendFile` + 队列串行，消除频繁步骤日志对事件循环的阻塞。新增 `cp.flushLog()` 供测试和关键路径等待挂起写入完成。
- **`memory.js` 进程内 entries 缓存**：`readEntries()` 不再每次调用都重新解析 `.jsonl` 文件。首次读取后缓存到 `_entriesCache`，`recordLearning` 写入时同步更新缓存，减少高频 `recall()` 的 I/O 开销。
- **`provider.js` `loadMergedConfig` 30s TTL 缓存**：并发编排场景下多个子任务重复读同一配置文件；现在进程内缓存 30 秒（可通过 `ttl=0` 或 `clearConfigCache()` 跳过），减少冗余磁盘 I/O。
- **`orchestrator/generate.js` `maxAttempts` 默认改为 3**：生成重试次数从 2（1 次重试）改为 3（2 次重试），对复杂 flow 生成更宽容；`orchestrate` / `orchestrateMulti` 支持透传 `maxAttempts` 选项供用户自定义。
- **`dashboard/render.js` 新增 7 个单元测试**：覆盖空 runs 列表、XSS 防护（title 转义）、内嵌 JSON 可反序列化、`<!-- ...-->` 注入转义、多 run 场景等，补足此前仅靠集成测试覆盖的空白。

## [0.2.9] - 2026-06-17

### 修复
- **`checkpoint.js` 旁路文件损坏不再崩溃**：步骤结果超过内联阈值时写入旁路文件（`steps/*.out`），SIGKILL 时可能写入不完整。续跑读取时 `JSON.parse` 失败现在会捕获异常、清除损坏记录并让该步骤重新执行，而不是向上抛出未捕获的 `SyntaxError` 导致整个 flow 崩溃。
- **`quality-gate.js` `onFail=resume-fix` 配置错误提前 fail-fast**：与 `onFail=autofix` 对齐，声明 `onFail=resume-fix` 但未提供 `resumeFix` 回调时，进门前立即抛 `configError=true` 错误，而不是静默降级为 rollback 行为。
- **`orchestrator/run.js` `acquireLock` 加重试上限**：stale 锁被清理后重试外层 `while(true)` 最多 `MAX_LOCK_RETRIES`（20 次）次，超过后抛出带提示的错误，消除极端情况下的死循环风险。

### 新增
- **`concurrency.js` `parallel()` 新增 `onError` 回调**：`strict=false` 模式下新增可选 `onError({index, error})` 参数，调用方可在保持 `null` 返回语义（向后兼容）的同时精确追踪失败任务，消除「任务失败」和「任务本身返回 null」无法区分的歧义。
- **`quality-gate.js` `runGates` 支持并发执行**：新增 `deps.parallel` 选项（默认 `false` 保持向后兼容），设为 `true` 时用 `parallel({ strict: true })` 并发跑所有独立门（`rollback`/`autofix` 策略适合并发，`resume-fix` 策略建议继续串行）。
- **`executor.js` `SAFE_OPTS_KEYS` 补入 `files`（aider 专用）**：agent profile 里现在可以声明 `files: ["src/main.rs"]` 并正确透传给 aider adapter，此前该字段被白名单过滤器静默丢弃。
- **`subflow.js` `fanOut` 动态调整 `MaxListeners`**：每个并发子 flow 注册 2 个 `process.once` 监听器（SIGINT/SIGTERM），高并发时超过 Node.js 默认 10 个上限会触发 `MaxListenersExceededWarning`。现在 `fanOut` 执行期间动态提升至 `limit * 2 + 10`，结束后恢复原值。

## [0.2.8] - 2026-06-17

### 修复
- **`subflow.runFlow` 信号监听器内存泄漏**：`process.once` 注册 SIGINT/SIGTERM 后，`done()` 里用新匿名函数调 `removeListener` 永远移除不掉旧监听（JS 按引用比较）。改为保存具名引用再移除，`fanOut` 并发跑多子 flow 时不再累积信号处理器。
- **`quality-gate.js` 依赖链修正**：从 `agent.js` import `spawnCapture` 改为直接从 `spawn.js` import，消除不必要的跨模块耦合，与 CLAUDE.md 架构描述对齐。
- **`executor.js` aider 缺失 `EXTRA_ARGS_WHITELIST` 条目**：aider 是 BYO-LLM 执行器（有 `applyProvider`），但白名单缺失导致 `extraArgs` 永远被拒（返回 `[]`）。补入安全 flag 白名单：`--model`、`--edit-format`、`--no-auto-commits`、`--no-dirty-commits`、`--read`。

### 架构
- **消除 `agent.js` ↔ `executor.js` 循环依赖**：`runAgent`/`runAgentChain`/`setWorkdir`/`AGENT_COOLDOWN_*` 迁入 `executor.js`，直接访问 `EXECUTORS`，彻底消除此前 `runAgent` 内 `dynamic import executor.js` 的技术债。`agent.js` 改为纯 CLI adapter 层，通过静态 re-export 保持公共 API 不变。ESM 安全：adapter 函数均为 function 声明（已提升），模块初始化顺序正确。

### 新增
- **`orchestrateMulti` 生成阶段并发限流**：新增可选参数 `genConcurrency`（默认 3）控制子任务 flow 生成的 LLM 并发度，替代原来的 `Promise.all` 无限并发，防止大目标拆分出多子任务时同时轰击 LLM API 触发 429。执行（fanOut）阶段由独立的 `concurrency` 参数控制，两者正交。

## [0.2.1] - 2026-06-15

### 新增
- **`loadGates` / `mergeGates`：业务项目自定义质量门（外置配置）**。补齐配置分层里「项目特定质量门放项目仓」长期缺位的能力，与 `loadProviders`/`loadAgents` 对称。业务项目在 `<repo>/.flowcast/gates.json`（committed，map by name 形态）声明自己的门（如 E2E、自定义脚本门），经 `loadGates({repo})` 加载、`mergeGates(builtin, project)` 与内置默认门合并（按门名去重，项目同名覆盖、新增追加在后）。门字段与 `runGate` 一致（`cmd`/`onFail`/`autofixCmd`/`cwd`/`timeout`）；`cmd` 走 `sh -c`，由 shell 自身做变量展开（不在 flowcast 层做 `${VAR}` 插值）。已在 `index.js` 导出、`FLOW_API.md` 登记，生成 flow 可直接 `import { loadGates, mergeGates } from 'flowcast'`。
- **`pipeline` 真流式无 barrier 语义**：每个 item 独立穿过所有 stage，无级间同步等待；支持 `{concurrency}` 并发限制（默认 CPU 核数）；stage 签名统一为 `(prev, item, index)`；per-item 容错（某 item 失败返回 null 不影响其他）。
- **`runAgent` / `runProfile` 增加可选 `schema`**：传 JSON Schema 时强制结构化输出，内置 JSON 提取 + 校验 + 不匹配重试；`schema.js` 独立导出 `validateSchema` / `runStructured` / `stubFromSchema`。
- **`verifyAdversarial` 对抗验证原语**（可选质量保证）：spawn 多个独立「怀疑者」agent 试图反驳 claim，按阈值表决；支持 `lenses`（多视角）、自定义 `threshold`、dry-run 短路。

### 修复
- **`cursor` / `agy` executor `extraArgs` 白名单**补充 `--trust`、`--force`、`--yolo`、`--dangerously-skip-permissions` 等运行时安全 flag，修复 Workspace Trust Required 导致 Cursor agent 无法启动的问题。
- **`loadMergedConfig` 机器级配置路径**同时搜索 `~/.flowx` 和 `~/.flowcast`，修复仅存在 `~/.flowx` 时配置被忽略的问题。
- **`runGate` 配置校验前置**：`onFail=autofix` 但缺少 `autofixCmd` 时在进门前立即 fail-fast（附 `configError=true`），不再等到检查命令失败后才报错。

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
