# 介绍

`flowcast` 是一个**轻量 workflow 编排框架**：断点续跑、HITL（人工介入）、多 CLI/agent 调度、自改安全沙箱、质量门，以及在其之上的 **L3 codegen 编排层**（动态生成并执行 flow）。

它的设计约束很简单也很硬：**零运行时依赖、纯 ESM、Node ≥ 20**。

## 为什么会有 flowcast

flowcast 的演进起点，是对三个项目的共性观察：

| 项目 | 是什么 | 核心机制 |
|------|--------|----------|
| **flowcast** | 轻量 workflow 编排框架 | Checkpoint 断点续跑、统一 `runAgent`、parallel/pipeline、HITL |
| **recursive** | 极简正交的 ReAct agent 内核（Rust） | 自改自身源码，靠 git worktree + 严格质量门（test/clippy/fmt）+ 回滚保安全 |
| **revengers** | 多 agent 任务编排引擎 | 声明式 `MISSION.md` + SQLite 状态对账；Scout 自主发现 / Self-Mod Guard / Merge Gatekeeper / L3 Arbiter；learnings 长期记忆；HITL 升级 |

抽象出来的共同范式（三者各自实现了一部分）：

1. **声明式目标 + 持久化状态机**：可恢复、可对账。
2. **自改安全沙箱**：worktree 隔离 + 质量门 + 失败回滚。
3. **执行器抽象**：把各种 CLI（Claude / Cursor / recursive 二进制）当作可互换的执行单元。
4. **生成-审查分离 + 质量门**：生成后必经验证，常由不同 agent 或严格自动检查把关。
5. **失败上下文 / learnings**：从失败中沉淀结构化知识，回喂给后续尝试。
6. **HITL 升级**：多级人工介入兜底。

结论：这些不该各写一遍。应当有一个**统一的自我迭代 flow 引擎**承载它们的共性——这就是 flowcast。

## 核心理念

### 原语优先

flowcast 的所有能力都是**可独立测试、可自由组合的一等公民原语**：`Checkpoint`、`runAgent`、`runGate`、`withSelfModGuard`、`fanOut`…… 一条 flow 只是这些原语的**薄编排**。你不需要学一套 DSL，写 flow 就是写普通 JS。

### codegen 为唯一主路径，不做 DAG

L3 动态编排**直接生成 flow 代码**（与人手写的 flow 同构），**不引入 DAG 抽象**。

理由：flow 逻辑本质是命令式的（条件 resume、budget 重试、verdict 分支），DAG 反而要为这些控制流再造一套表达，得不偿失。codegen 出来的就是能被人读、能被 dry-run 校验的真实 flow。

护栏三件套：

- **约束式生成**：词汇表（`FLOW_API.md`）+ 骨架 + 黄金样例。
- **跑前校验**：语法 + import 白名单 + dry-run。
- **持久化 + 续跑锁定**：生成的 flow 落盘，续跑复用产物。

### 零业务泄露

- **flowcast 仓 = 通用库**：L1 adapter + L2 引擎原语 + provider/agent schema + L3 orchestrator。仓内**不含任何端点、密钥、业务质量门**。
- **项目特定 flow + 配置**（质量门命令、provider 名）→ 放各自项目仓，通过 `file:` 依赖把 flowcast 当库消费。
- **机器级状态/密钥**（run checkpoints、API key）→ `~/.flowcast/` 或 gitignore 的 `.flowcast/`。

详见 [配置分层](/guide/configuration)。

## 适合什么场景

- 把一段需要**多步骤、可能中断、需要人工确认**的 AI 编码流程固化成可续跑的 flow。
- 让 agent **安全地修改代码**（包括改自己），失败自动回滚。
- 用**统一接口**调度多个 coding agent（Claude / Cursor / …），按能力路由、并发执行。
- 把"一行需求"端到端**自动生成并执行**成一条受约束、可审计的 flow。
- 跑 **goal-driven 循环**（`loop`）：每轮迭代 + 质量门验证 + 跨-run 记忆沉淀，直到达成目标。
- 对关键发现做**对抗式验证**（`verifyAdversarial`）：多怀疑者独立试图反驳，按阈值表决置信度。

## 不做什么

flowcast 是**进程定义/编排层**，不是运行时治理框架。它刻意**不吸收** revengers 那样的运行时能力（SQLite 状态机、daemon、锁、常驻 dashboard 服务）。运行时治理仍归上层系统；flowcast 只负责把"一个具体任务怎么跑"定义好、跑好、跑得可续跑。

下一步：[快速上手](/guide/getting-started)。
