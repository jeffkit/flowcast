# AGENTS.md — flowcast

> 轻量 workflow 编排：断点续跑 · HITL · 多 Agent 调度 · 自改沙箱 · 质量门 + L3 codegen。
> 负责人：jeffkit | 创建：2026-06-11
> 本文件是 AI / 开发者进入仓库的**唯一导航契约**。（`CLAUDE.md` 为本文件的软链，Claude Code 入口。）

`flowcast` 是一个轻量 workflow 编排框架：断点续跑、HITL、多 CLI/agent 调度、
自改安全沙箱、质量门，以及在其之上的 L3 codegen 编排层（动态生成并执行 flow）。
**纯 ESM、Node ≥ 20。核心编排依赖 agentproc SDK；dashboard/L3 codegen 另携带 react/react-dom/react-router-dom、@xyflow/react、@dagrejs/dagre、elkjs、acorn/acorn-walk 等运行时依赖（以 package.json dependencies 实际清单为准）。**

> **新 session 先读 [docs/BACKGROUND.md](docs/BACKGROUND.md)**——flowcast 的来龙去脉与愿景
> （统一自我迭代引擎、三层架构、边界决策、路线图）。本文只讲架构与 API。

**主仓库：** `git@github.com:jeffkit/flowcast.git`

## 三层架构（核心心智模型）

```
L3 编排层 (orchestrator/)   接单 → 动态生成 flow 代码 → 校验 → 执行（续跑锁定）
L2 引擎   (核心原语)        定义并跑好「单个 flow」：Checkpoint / 自改沙箱 / 质量门 / HITL / dry-run
L1 执行器 (agentproc in-process executor + executor/ 适配器 + executor.js) 怎么驱动一个 CLI/agent + provider 能力分层 + 路由
```

- **L1 执行器**：实际 CLI 调用走 agentproc SDK 的 in-process executor（buildArgs/parseEvent/env 翻译由 agentproc 提供），
  `executor/` 目录放适配器（`agentproc-adapter.js` 翻译层 / `dsh.js` / `recursive-extras.js`），`executor.js` 持 `EXECUTORS` 注册表 + 能力表做路由。
  执行器是否「接受外部 provider」由注册表 `acceptsProvider`（按 BYO-LLM CLI 列表派生）决定——
  BYO-LLM（recursive/aider/claude）可注入 provider；锁定型（cursor 等）自管鉴权，给 provider 会 fail-fast。
- **L2 引擎**：原语都是可独立组合的一等公民，flow 只是它们的薄编排。
- **L3 codegen harness**：**codegen 为唯一主路径**（生成 flow 代码，与人手写同构），**不做 DAG**。
  三道护栏：约束式生成（词汇表+骨架）／跑前校验（语法+import 白名单+dry-run）／持久化+续跑锁定。

业务项目的 flow 放各自仓（如 `.flowcast/flows/`），本仓只放引擎与通用示例。

## 模块地图

| 文件 | 职责 |
|------|------|
| `index.js` | 公共 API 出口（所有对外导出都在这里登记） |
| `errors.js` | 统一错误类型层次：`FlowcastError` 基类 / `TimeoutError` / `SpawnError` / `GateError` / `SchemaError` / `ConfigError` / `PathError`；`isRetryable` 是唯一 provider 回退判定入口 |
| `checkpoint.js` | `Checkpoint`：断点续跑的步骤记录（`cp.step` / `cp.done` / pauseContext） |
| `spawn.js` | 底层进程原语：`spawnCapture`（捕获式）/ `spawnCli`（spawnCapture 薄包装，失败抛 `TimeoutError`/`SpawnError`）/ `isProviderRetryable` / `sweepStaleTmp`（stale 临时文件清理）。单一事实来源，消除 spawnCli/spawnCapture 双实现漂移。 |
| `concurrency.js` | `parallel`（barrier，默认 `strict=true` 任一失败则汇总抛错）/ `pipeline`（无 barrier 流水线）。与执行器解耦，可独立测试。 |
| `hitl.js` | HITL 子系统：`setHitlBackend` / `waitForInput` / `notify`，支持 terminal/wecom/自定义后端。 |
| `executor/` | 执行器适配器目录：`agentproc-adapter.js`（flowcast ↔ agentproc 翻译层：CLI 名 → executor 名、opts → profile、RunResult → makeAgentResult）+ `dsh.js`（dsh executor 描述符注入 agentproc）+ `recursive-extras.js`（recursive `_meta` 增强：finishReason/panicked/transcript）。v0.6 起 per-CLI adapter 实现由 agentproc SDK in-process executor 承担，adapters.js 已删除。 |
| `agent.js` | 向后兼容聚合层：从 `executor.js` / `spawn.js` / `concurrency.js` / `hitl.js` / `provider.js` / `executor/` re-export，保持公共 API 稳定。不含实现逻辑。 |
| `schema.js` | `validateSchema` / `stubFromSchema` / `extractJson` / `runStructured`：轻量 JSON Schema 校验 + 强制 agent 结构化输出（增强 prompt+抽 JSON+校验+回喂重试），零依赖；失败抛 `SchemaError` |
| `verify.js` | `verifyAdversarial`：对抗式验证原语（多怀疑者/多视角 + 阈值表决），可选质量保证，与 `runGate` 互补、非强制环 |
| `provider.js` | provider profile：`interpolateEnv`（`${VAR}`）+ `loadProviders` + `resolveProvider` + 通用 `loadMergedConfig` |
| `rate-limiter.js` | 自学习限流感知：LLM 解析限流错误沉淀特征库（`~/.flowcast/rl-patterns.json`），命中直接跳过；当前限流状态落 `~/.flowcast/rate-limits.json`（CLI `rate-limits` 命令读取/清除） |
| `executor.js` | 执行器装配 + 路由层：`EXECUTORS` 注册表（内置 entry 由 CLI_TO_EXECUTOR + agentproc SDK 派生，实际 CLI 调用走 in-process executor）+ 执行器能力表（streaming/permission/sessionResume）+ `getExecutor` + `loadAgents` + `resolveAgent`（绑定+校验）+ `runAgent`（路由到正确 executor）+ `runAgentChain`（跨 CLI 链式回退）+ `setWorkdir`。provider 翻译器在 `provider.js`（`claudeProviderEnv`/`recursiveProviderEnv`/`aiderProviderEnv`/`applyProviderToProfile`），本文件不重复定义。 |
| `self-mod-guard.js` | `withSelfModGuard` / `captureBaseline`：自改安全沙箱（失败硬回滚） |
| `quality-gate.js` | `runGate` / `runGates`：质量门（rollback / resume-fix / autofix）；`loadGates` / `mergeGates`：业务项目从 `<repo>/.flowcast/gates.json` 声明式自定义门（与 provider/agent 配置对称），与内置默认门合并 |
| `failure-context.js` | `writeFailureContext` / `readAndConsumeFailureContext`：失败上下文（写入即消费，单轮热路径） |
| `memory.js` | `recordLearning` / `recall` / `buildMemorySection` / `promoteFailureContext`：轻量「跨-run」记忆（文件型 jsonl + 关键词/tag 召回，failure-context 的跨-run 超集） |
| `loop.js` | `loop`：goal-driven 循环原语（每轮 fresh context 迭代 + budget 封顶 + 复用 Checkpoint 续跑 + quality-gate 每轮硬验证 + 可选 memory 沉淀）。同步函数、跑完即返，不是 daemon |
| `git.js` | `gitStatus` / `gitDiff` / `gitCommitAll` / `gitWorktreeAdd` / `gitWorktreeRemove`：给生成的 flow 用的受控 git 原语（含 worktree 隔离） |
| `subflow.js` | `runFlow`：把另一条 flow 当隔离子进程跑；`fanOut`：并发编排多条子 flow（限并发 + worktree 隔离 + per-task 日志 + 汇总） |
| `run-script.js` | `runScript`：动态受限脚本编排面（五钩子 `agent`/`parallel`/`pipeline`/`phase`/`log` + `args` 注入），每个 `agent()` 调用绑一个 checkpoint（断点续跑）；new Function 非安全沙箱，脚本信任级等同 bash |
| `dry-run.js` | `isDryRun`：dry-run 开关（`FLOWCAST_DRY_RUN`；`FLOWX_DRY_RUN` deprecated 向后兼容） |
| `orchestrator/` | L3：`FLOW_API.md`（契约）+ `templates/` + `examples/` + `validate.js` + `generate.js` + `decompose.js`（接单分拆）+ `run.js`（`orchestrate`/`orchestrateMulti`）+ `cli.js`（`flowcast orchestrate [--split]`） |
| `dashboard/` | 可观测看板（只读）：`collect.js`（扫 `.flowcast/runs` + worktree、重建父子树、僵尸推断）+ `render.js`（单文件 HTML）+ `cli.js`（`flowcast dashboard [--open]`）。埋点经 `cp.event` / `setAgentEventSink` / 质量门 `onEvent` 写入 jsonl |
| `flows-registry.js` | flow 清单扫描：把项目级 `<repo>/.flowcast/flows/` 与用户级 `~/.flowcast/flows/` 的 .js/.mjs 扫成结构化清单，供 dashboard Workflows tab 与 CLI `flows list` 共用 |
| `events.js` | 事件常量与 schema 中央注册表（`EVENT`）：agent 侧（fallback/rate-limit）与 checkpoint 侧（gate/group）事件的单一事实来源，emit 点 import 常量避免拼写漂移 |
| `examples/` | 通用示例：`goal-drive.js`（goal-driven 循环 flow 示例）。**项目特定 flow 放各自仓**（如 recursive 自改 flow 在 `recursive` 仓 `.dev/flows/`，ilink-hub 技术债消化 flow 在 `ilink-hub/.flowcast/flows/`，均通过 `file:` 依赖消费本包） |
| `skills/flowcast/` | flowcast 配套 Claude Code skill：`SKILL.md`（主体，含路由表）+ `references/`（create/run/debug/config 四个参考文档）。安装：`cp -r skills/flowcast ~/.claude/skills/` |
| `bin/flowcast.js` | CLI 入口 |

## 常用命令

```bash
npm test                          # node --test test/（全量单测，含结构化 E2E，不烧 API）
node --check <file>               # 语法校验
npm install -g .                  # 本地装 CLI（可选）

flowcast run ./flows/my-flow.js [args]    # 跑自定义 flow 文件（续跑传同一 --run-id）
flowcast flows list                       # 列出已安装的用户级 flow（~/.flowcast/flows/）
flowcast rate-limits                      # 列出活跃限流记录（rate-limits clear [cli/model] 清除）
flowcast dashboard-server --open          # 启动聚合 dashboard 服务（多项目 web UI）
flowcast orchestrate "<编排需求>" --repo .     # L3：编排需求 → 生成 flow → 校验 → 执行（续跑锁定）
flowcast orchestrate "<大目标>" --split    # L3 接单分拆：拆子任务 → 各自生成 flow → fanOut 并发执行
flowcast dashboard --repo . [--open]      # 扫 .flowcast/runs + worktree → 生成只读可观测看板 HTML
flowcast list                             # 列出所有 run

# 自我迭代（recursive 仓自改）—— flow 在 recursive 仓，flowcast 作为库被消费
# 见 recursive 仓 .dev/flows/SELF_IMPROVE.md
```

## 配置分层（重要）

provider / agent 配置**绝不硬编码在代码里**，按内容性质三分：

| 内容 | 放哪 |
|------|------|
| 通用 flow 逻辑 + adapter + provider/agent schema | **flowcast 库**（本仓） |
| 项目特定 flow 配置（质量门、provider/agent 名） | **项目仓 `.flowcast/`**（committed） |
| 机器级状态 + 密钥（run checkpoints、API key） | **`~/.flowcast/`** 或 gitignore 的 `.flowcast/` |

- `~/.flowcast/providers.{json,yaml,js}`（机器级）→ `<repo>/.flowcast/providers.*`（项目级覆盖）。
- 密钥用 `${ENV_VAR}` 运行时插值，**明文永不入仓**（缺变量 fail-fast）。
- 示例见 `examples/providers.example.json` / `examples/agents.example.json`。

## 开发约定

**分支策略：** `main`；PR 合并。

**禁止事项：**
- 禁止把 API Key / provider 明文写进仓（用 `~/.flowcast/*.json` + `${ENV}`）
- 禁止在本仓堆业务项目专用 flow（放业务仓，`file:` 依赖本包）
- 禁止绕过质量门 / 自改沙箱做「方便的」自改
- 禁止随意引入运行时 npm 依赖（设计约束：最小依赖；当前运行时依赖见 `package.json` dependencies——核心编排为 agentproc，dashboard/L3 codegen 另带 react 系/@xyflow/react/@dagrejs/dagre/elkjs/acorn 系）

**代码约定：**
- **最小依赖**：核心编排依赖 `agentproc` SDK；dashboard/L3 codegen 另依赖 react/react-dom/react-router-dom、@xyflow/react、@dagrejs/dagre、elkjs、acorn/acorn-walk（以 `package.json` dependencies 实际清单为准）。新增依赖前先确认是否真的必要——这是核心设计约束。
- **纯 ESM**：所有文件 `import`/`export`；新对外 API 必须在 `index.js` 登记。
- **原语优先**：先做可独立测试的一等公民原语，flow 只做薄编排。新原语必须带单测。
- **dry-run 可跑**：写 flow / 改原语时保证 `FLOWCAST_DRY_RUN=1` 下能跑通骨架（假执行器 + 假质量门）。`FLOWX_DRY_RUN` 已弃用，向后兼容保留但不推荐。
- **测试用假执行器**：E2E 用 fake CLI / fake gate / temp git repo，不烧 API、不依赖外部环境。
- **生成的 flow 受约束**：只能 import `flowcast`（+ `util`），只用 `FLOW_API.md` 列出的原语；需要 git/文件操作时走 flowcast 暴露的原语，不裸调 `child_process`。

## Git 提交规范

提交时**不要**添加 `Co-Authored-By`、`Generated by` 等 AI 署名，直接用操作者的 git 身份提交。

## 长任务

四件套在 `docs/exec-plans/active/<task>/`：`prompt.md`（冻结目标）→ `plan.md`（里程碑）→
`implement.md`（执行日志）→ `status.md`（AI 恢复入口，先读它）。

## 当前状态

**当前里程碑：** {待人工填写}

## 深入阅读

| 文档 | 说明 |
|------|------|
| `README.md` | 安装与快速上手 |
| `docs/BACKGROUND.md` | 背景与路线图 |
| `orchestrator/FLOW_API.md` | L3 契约 |
| https://jeffkit.github.io/flowcast/ | 站点文档 |
