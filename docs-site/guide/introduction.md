# 介绍

`flowcast` 是一个**轻量 workflow 编排框架**：断点续跑、HITL（人工介入）、多 CLI/agent 调度、自改安全沙箱、质量门，以及在其之上的 **L3 codegen 编排层**（动态生成并执行 flow）。

它的设计约束很简单也很硬：**最小依赖（运行时仅依赖 agentproc SDK）、纯 ESM、Node ≥ 20**。

## 设计理念

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
- 把一段**多步骤的编排需求**端到端**自动生成并执行**成一条受约束、可审计的 flow。
- 跑 **goal-driven 循环**（`loop`）：每轮迭代 + 质量门验证 + 跨-run 记忆沉淀，直到达成目标。
- 对关键发现做**对抗式验证**（`verifyAdversarial`）：多怀疑者独立试图反驳，按阈值表决置信度。

## 不做什么

flowcast 是**进程定义/编排层**，不是运行时治理框架。它刻意不做这些：常驻 daemon、状态机服务、锁治理、实时 dashboard 服务、DAG 抽象。运行时治理归上层系统；flowcast 只负责把"一个具体任务怎么跑"定义好、跑好、跑得可续跑。

下一步：[快速上手](/guide/getting-started)。
