# ADR: dsh workflow 整合采用「分层」而非「内嵌」

- 日期：2026-08-16
- 状态：已接受（Accepted）
- 背景：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）内置了完整的动态工作流体系（`workflow` 工具 + `ctx.workflowEngine` seam + worker-thread 引擎 + `ctx.subagents` 子 agent 服务）。曾评估"把 flowcast 做成 dsh 的第二个 WorkflowEngine"，本 ADR 记录对比与决策。

## 决策

**不做 dsh 内嵌引擎；保持分层：flowcast 在各种 agent 之上编排，dsh 管自己内部的编排。**

两层的对接走已建成的链路（而非进程内嵌合）：

```
flowcast（跨 agent 编排层）
  ├─ executor: dsh        （flowcast step → dsh headless CLI，已实现并测试）
  ├─ agentproc dsh profile（微信/邮件通道 → dsh，特性探测多轮，已实现）
  └─ 未来：dsh fork 构建 --resume 发布后自动升级为有状态
dsh（agent 运行时）
  └─ workflow 工具 + ctx.subagents（in-turn 编排，dsh 自有生态）
```

## 对比（2026-08 实测源码结论）

| 维度 | dsh 官方引擎 | flowcast 内嵌引擎（被否方案） |
|---|---|---|
| in-turn 动态编排 | 原生设计目标 | 翻译层实现 |
| 子 agent 执行体 | `ctx.subagents` 原生（审计/审批/投影继承） | 同样走它（无增益） |
| 异构 agent | 已有 claude-code/codex/dsh-sdk/acp 四 provider | 无增益 |
| 取消/中止 | 与 turn 生命周期深度集成 | 需翻译，易失真 |
| 断点续跑 | ❌ deferred（自认） | ✅ |
| 质量门/失败上下文/记忆 | ❌ | ✅ |
| HITL | ✅（审批 seam） | 无增益 |

差异化只剩「断点续跑 + 质量门」，而断点续跑有架构陷阱：dsh 的 workflow 是**前台工具调用内编排**，重启续跑的前提是 dsh 先有后台 run 模型——同样是上游 deferred。内嵌引擎实际要替宿主补两个 deferred 特性，超前于宿主自己的生命周期模型。

## 定位声明

这个分工不是妥协，是各就其位：

- **dsh**：一个 agent 运行时内部的编排（self-contained，turn 生命周期内，fan-out 自己的 subagent）
- **flowcast**：**各种 agent 之上的编排**（跨 CLI、跨进程、跨天，持久化是这一层的本职）

持久化住在以持久化为职责的层。

## 重新触发条件

出现以下任一情况时重开评估：

1. dsh 落地后台 run 模型（background start/poll，其 deferred 特性）——届时 seam 上挂 flowcast 引擎才有宿主语义可依托
2. 出现「会话内工作流须扛过重启」的具体业务（如 dsh 会话内大型重构流水线）
3. 重开时的优选姿势：给官方引擎补 journaling（同 `--resume` PR 路径），而非平行第二引擎

## 关联

- 借鉴清单（不代表整合决策）：[NOTES-dsh-workflow-borrowings.md](./NOTES-dsh-workflow-borrowings.md)
- 已落地对接：`executor/agentproc-adapter.js` 的 dsh 映射；agentproc 仓 `hub/dsh/`
