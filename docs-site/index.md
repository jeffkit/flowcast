---
layout: home

hero:
  name: flowcast
  text: 轻量 workflow 编排框架
  tagline: 断点续跑 · HITL · 多 CLI/agent 调度 · 自改安全沙箱 · 质量门，以及其上的 L3 codegen 编排层。零运行时依赖 · 纯 ESM · Node ≥ 20。
  actions:
    - theme: brand
      text: 快速上手
      link: /guide/getting-started
    - theme: alt
      text: 什么是 flowcast？
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/jeffkit/flowcast

features:
  - title: 断点续跑
    details: Checkpoint 把 flow 拆成可记录的步骤，中断后用同一个 run-id 续跑，已完成步骤零重复执行。
  - title: 人工介入（HITL）
    details: 可插拔 HITL 后端（terminal / 企业微信），在关键节点阻塞等人工决策或单向通知，支持异步协作。
  - title: 多 CLI/agent 调度
    details: claude / cursor / gemini / codex / aider / recursive 各有 adapter，统一 runAgent 驱动，可路由、可并行、可互换。
  - title: 自改安全沙箱
    details: withSelfModGuard 在 git baseline 上隔离自改，质量门失败硬回滚，让 agent 安全地改自己的代码。
  - title: 质量门
    details: runGate / runGates 把测试、lint、构建等检查纳入 flow，失败可 rollback / resume-fix / autofix。
  - title: L3 codegen 编排
    details: 一行需求 → 动态生成 flow 代码 → 校验（语法 + import 白名单 + dry-run）→ 隔离执行（续跑锁定）。不做 DAG。
  - title: 并发子 flow
    details: fanOut 限并发 + worktree 隔离 + 每任务日志 + 结果汇总；runFlow 把一条 flow 当隔离子进程跑。
  - title: 可观测看板
    details: 扫描 .flowcast/runs 与 worktree，重建父子运行树、推断僵尸进程，生成只读单文件 HTML 看板。
  - title: 零运行时依赖
    details: 核心不引第三方包，纯 ESM，配置与密钥全部外置（${ENV} 运行时插值），明文永不入仓。
---

## 三层架构

flowcast 的核心心智模型是把"自我迭代"拆成三层，每层职责单一、可独立组合：

```
L3 编排层 (orchestrator/)         接单 → 动态生成 flow 代码 → 校验 → 执行（续跑锁定）
L2 引擎   (核心原语)              定义并跑好「单个 flow」：Checkpoint / 自改沙箱 / 质量门 / HITL / dry-run
L1 执行器 (agent.js + executor.js) 怎么驱动一个 CLI/agent + provider 能力分层 + 路由
```

- **L1 执行器**：把各种 coding agent（Claude / Cursor / recursive 内核 …）当作可互换、可路由、可并行的无状态 worker。
- **L2 引擎**：flowcast 本体——把一个 flow 跑得可审计、可观测、可断点续跑。原语都是一等公民，flow 只是它们的薄编排。
- **L3 编排**：更高一层的任务调度器——接单、分拆需求、**动态生成** flow 代码并跨 agent 调度。codegen 为唯一主路径，不做 DAG。

## 30 秒上手

```bash
# 全局安装 CLI
npm install -g flowcast

# 一行需求，端到端跑通：生成 flow → 校验 → 执行
flowcast orchestrate "把 README 里的 TODO 清单逐条实现" --repo .

# 安装团队 flow，按名字运行
flowcast flows install /path/to/force-dev.js
flowcast run force-dev --feature my-feature --repo .

# 跑自定义 flow（dry-run 不烧 API）
FLOWCAST_DRY_RUN=1 flowcast run ./my-flow.js
```

> 想了解 flowcast 的来龙去脉与设计取舍，从 [介绍](/guide/introduction) 开始。
