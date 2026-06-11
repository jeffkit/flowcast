# 项目背景与愿景（flowx 为什么是现在这样）

> 本文是 flowx 的「来龙去脉」叙事文档，回答 **为什么这么做、要去哪**。
> 架构与 API 看 [CLAUDE.md](../CLAUDE.md)；步骤级执行记录看 [docs/exec-plans/](exec-plans/)。
> 新 session 进入 flowx 工作前，**先读本文**建立大局观。

---

## 1. 缘起：三个项目的共性

flowx 的演进起点，是对 FORCE Lab 三个项目的共性观察：

| 项目 | 是什么 | 核心机制 |
|------|--------|----------|
| **flowx** | 轻量 workflow 编排框架 | Checkpoint 断点续跑、统一 `runAgent`、parallel/pipeline、HITL |
| **recursive** | 极简正交的 ReAct agent kernel（Rust） | 自改自身源码，靠 git worktree + 严格质量门（test/clippy/fmt）+ 回滚保安全 |
| **revengers** | 多 agent 任务编排引擎 | 声明式 `MISSION.md` + SQLite 状态对账；Scout 自主发现 / Self-Mod Guard / Merge Gatekeeper / L3 Arbiter；learnings 长期记忆；HITL 升级 |

**抽象出来的共同范式**（三者各自实现了一部分）：

1. **声明式目标 + 持久化状态机**：可恢复、可对账。
2. **自改安全沙箱**：worktree 隔离 + 质量门 + 失败回滚。
3. **执行器抽象**：把各种 CLI（Claude/Cursor/recursive 二进制）当作可互换的执行单元。
4. **生成-审查分离 + 质量门**：生成后必经验证，常由不同 agent 或严格自动检查把关。
5. **失败上下文 / learnings**：从失败中沉淀结构化知识，回喂给后续尝试。
6. **HITL 升级**：多级人工介入兜底。

结论：这些不该各写一遍。应当有一个**统一的自我迭代 flow 引擎**承载它们的共性。

---

## 2. 愿景：统一的自我迭代 flow 引擎（三层架构）

```
L3 编排层   接单 → 分拆 → 动态生成 flow 代码 → 跨 coding agent 调度
            （类似但超越 Claude Code 的 /workflow：它是跨 coding agent 的）
L2 进程引擎  flowx 本体：定义并跑好「单个 flow」——断点续跑 / 审计 / 自改沙箱 / 质量门 / HITL / dry-run
L1 执行器    一个个 coding agent（Claude / Cursor / recursive 内核 …）：可互换、可路由、可并行的无状态 worker
```

- **L1**：执行器是被调度的、可替换的 worker。
- **L2**：**flowx 就是这一层**——把一个 flow 跑得可审计、可观测、可断点续跑。
- **L3**：更高一层的任务调度器（revengers 的"大脑"角色）——接单、分拆需求、**动态生成** flow 代码并调度执行。

---

## 3. 边界与关键架构决策

### 3.1 flowx 是「进程定义层」，不是 revengers 的运行时替代
flowx **不吸收** revengers 的运行时能力（SQLite 状态机、daemon、锁、dashboard）。
flowx 为 revengers 提供的是**进程定义/编排层**：revengers 接单分拆后，把"一个具体任务怎么跑"
交给 flowx 定义和执行。运行时治理仍归 revengers。

### 3.2 通用库 vs 项目特定（零业务泄露）
- **flowx 仓 = 通用库**：L1 adapter + L2 引擎原语 + provider/agent schema+resolver + L3 orchestrator。
  仓内**不含任何端点、密钥、业务质量门**。
- **项目特定 flow + 配置**（质量门命令、provider 名）→ 放**各自项目仓**，通过 `file:` 依赖把 flowx 当库消费。
- **机器级状态/密钥**（run checkpoints、API key）→ `~/.flowx/` 或 gitignore 的 `.flowx/`。

> 实证：recursive 的自改 flow 已迁回 `recursive/.dev/flows/`，import `@force-lab/flowx`，
> `npm test` 双 E2E 全绿——验证了"库消费模型"成立。

### 3.3 L3 = codegen 唯一主路径，不做 DAG
L3 动态编排**直接生成 flow 代码**（与人手写的 flow 同构），**不引入 DAG 抽象**。
理由：flow 逻辑是命令式的（条件 resume、budget 重试、verdict 分支），DAG 反而要为这些控制流
再造一套表达，得不偿失；codegen 出来的就是能被人读、能被 dry-run 校验的真实 flow。
护栏三件套：**约束式生成**（词汇表 + 骨架 + 黄金样例）／**跑前校验**（语法 + import 白名单 + dry-run）／**持久化 + 续跑锁定**。

### 3.4 分阶段推进
先用 **recursive 当垫脚石**把 flowx 的自改/质量门/HITL 原语锤实，再**选择性**吸收 revengers 的
L3 编排理念。不一次性大融合。

---

## 4. 已完成（截至 2026-06-11，已并入 flowx `main`）

| 阶段 | 产出 |
|------|------|
| **Step 1：recursive 集成** | 抽出 5 个一等原语：自改沙箱 `self-mod-guard.js` / 质量门 `quality-gate.js` / 失败上下文 `failure-context.js` / 可插拔 HITL（terminal·wecom）/ recursive adapter（`agent.js`）。真实 parity 验过 committed×1 + rolled-back×2。 |
| **Provider 标准化** | `provider.js`：`${VAR}` 插值（借鉴 ilink-hub bridge profile）+ 多层加载（`~/.flowx` + `<repo>/.flowx`）+ `resolveProvider`。端点/密钥彻底移出仓库。 |
| **执行器能力分层** | `executor.js`：`EXECUTORS` 注册表区分 BYO-LLM（recursive/aider/claude，可注入 provider）与锁定型（cursor/gemini/codex，给 provider 即 fail-fast）；`resolveAgent` 绑定+校验。 |
| **L3 codegen harness** | `orchestrator/`：契约 `FLOW_API.md` + 骨架 + 黄金样例 + `validate.js`（语法/白名单/dry-run）+ `generate.js` + `run.js`（隔离执行 + 续跑锁定）。 |
| **收尾** | recursive 专属 flow 迁回 recursive 仓；flowx 只留通用能力；74 单测全绿。 |

---

## 5. 路线图（下一步重点）

1. **L3 动态编排 dogfooding**：接单 → 分拆 → 动态生成 flow → 跨 executor 调度，复用 `resolveAgent` 路由。
   当前 codegen harness 已具备生成/校验/执行/续跑锁定的骨架，下一步是把"接单分拆"的上层接通并跑真实任务。
2. **revengers 选择性集成**：只取其 L3 编排理念（接单/分拆/调度/Arbiter），**不吞**其运行时（SQLite/daemon/锁/dashboard）。
3. **review 健壮化**：goal 在 `recursive/.dev/flows/goals/001-self-review-structured-verdict.md`，留给 self-improve 自己 dogfooding。
4. **selfImprove preset（通用内置 flow）**：暂缓（kongjie 决定先放）。

---

## 6. 与 recursive / revengers 的当前关系

- **recursive**：既是「被 L1 调度的执行器之一」，也是「Step 1 的垫脚石 + 首个库消费方」。其 Rust kernel 一行不改。
- **revengers**：L3 编排理念的来源。flowx 的定位是做它的「进程定义层」，而非运行时。

---

## 7. 关键决策时间线（kongjie 拍板）

- 认可"统一自我迭代引擎"方向，先做起来。
- L3 是超越 /workflow 的、跨 coding agent 的动态编排层 → 确认。
- 先做 recursive 真实 parity（deepseek / minimax key 就绪）。
- 由 AI 来 review 试水 goal；review 健壮化写成 goal 留待 dogfooding。
- L2 引擎内核独立；provider 配置标准化、外置（参考 ilink-hub）→「现在做」。
- 先做执行器能力分层，内置 flow 暂缓。
- L3 放 flowx 内；codegen 为唯一路径，不做 DAG。
- 合并 main；recursive 专属内容迁回 recursive 仓 + 写 AI 使用指引。
