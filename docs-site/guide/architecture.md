# 三层架构

flowcast 的核心心智模型，是把"自我迭代"拆成三层，每层职责单一、可独立组合：

```
L3 编排层 (orchestrator/)          接单 → 动态生成 flow 代码 → 校验 → 执行（续跑锁定）
L2 引擎   (核心原语)               定义并跑好「单个 flow」：Checkpoint / 自改沙箱 / 质量门 / HITL / dry-run
L1 执行器 (adapters.js + executor.js)  怎么驱动一个 CLI/agent + provider 能力分层 + 路由
```

## L1 — 执行器

执行器是被调度的、**可替换的无状态 worker**。每个 coding agent（`recursive` / `claude` / `cursor` / `gemini` / `codex` / `aider`）各有一个 adapter，统一由 `runAgent` 驱动。

执行器**是否接受外部 provider**，由它有没有 `applyProvider` 翻译器派生：

| 类型 | 执行器 | provider 行为 |
|------|--------|---------------|
| **BYO-LLM**（自带 LLM） | `recursive` / `aider` / `claude` | 可注入 provider（apiBase / model / apiKey） |
| **锁定型** | `cursor` / `gemini` / `codex` | 自管鉴权，给 provider 会 **fail-fast** |

`resolveAgent(name, agents, { providers })` 负责把一个 agent profile 名**绑定 + 校验**成 `{ run, opts }`，并在锁定型执行器被错误注入 provider 时立刻报错。

> 关键能力：执行器可**路由**（按能力选）、可**并行**（`parallel` / `fanOut`）、可**互换**（同一段 flow 换个 agent 名即可）。

## L2 — 引擎

**flowcast 本体就是这一层**：把一个 flow 跑得**可审计、可观测、可断点续跑**。

L2 的所有能力都是**可独立测试、可自由组合的一等公民原语**，flow 只是它们的薄编排：

| 原语 | 职责 |
|------|------|
| `Checkpoint` | 断点续跑的步骤记录（`cp.step` / `cp.done` / pause） |
| `withSelfModGuard` | 自改安全沙箱：失败硬回滚 |
| `runGate` / `runGates` | 质量门：rollback / resume-fix / autofix |
| `waitForInput` / `notify` | 可插拔 HITL（terminal / 企微） |
| `writeFailureContext` | 失败上下文落盘，下次注入 prompt |
| `isDryRun` | dry-run 开关，结构冒烟不烧 API |

## L3 — 编排

更高一层的任务调度器（revengers 的"大脑"角色）——**接单、分拆需求、动态生成 flow 代码并调度执行**。它类似但超越 Claude Code 的 `/workflow`：它是**跨 coding agent** 的。

L3 的关键决策是 **codegen 为唯一主路径，不做 DAG**：

- 直接生成 flow 代码（与人手写同构），不引入 DAG 抽象。
- flow 逻辑本质是命令式的（条件 resume、budget 重试、verdict 分支），DAG 反而要为这些控制流再造一套表达。
- codegen 出来的就是能被人读、能被 dry-run 校验的真实 flow。

护栏三件套：

1. **约束式生成**：词汇表（`FLOW_API.md`）+ 骨架 + 黄金样例。
2. **跑前校验**：语法 + import 白名单 + dry-run。
3. **持久化 + 续跑锁定**：生成的 flow 落盘，续跑复用产物。

详见 [L3 编排](/guide/orchestration)。

## 边界：flowcast 不是什么

flowcast 是**进程定义 / 编排层**，不是运行时治理框架。

它刻意**不吸收** revengers 那样的运行时能力（SQLite 状态机、daemon、锁、常驻 dashboard 服务）。flowcast 为上层系统提供的是"一个具体任务怎么跑"的定义和执行；运行时治理仍归上层。

## 配置三分（零业务泄露）

| 内容 | 放哪 |
|------|------|
| 通用 flow 逻辑 + adapter + provider/agent schema | **flowcast 库**（本仓） |
| 项目特定 flow 配置（质量门、provider/agent 名） | **项目仓 `.flowcast/`**（committed） |
| 机器级状态 + 密钥（run checkpoints、API key） | **`~/.flowcast/`** 或 gitignore 的 `.flowcast/` |

详见 [配置分层](/guide/configuration)。
