# prompt.md — L3 Codegen Harness（冻结目标）

> 本文件冻结目标与边界。实现细节看 plan.md / implement.md，AI 恢复看 status.md。

## 背景

flowcast 已完成 L1（执行器能力分层 + `resolveAgent` 路由）与 L2（Checkpoint、自改沙箱、
质量门、HITL、断点续跑）。现在做 L3——编排调度层：接单 → 动态生成 flow → 校验 → 执行。

kongjie 已拍板的方向（2026-06-11）：

- **L3 放 flowcast 内**（`orchestrator/` 模块，与 L2 原语分目录）。
- **codegen 为唯一主路径**：L3 生成的产物就是 flowcast flow **代码**，与人手写的同构。
- **不做 DAG 抽象**：真实 flow 是命令式控制流（循环/条件/重试），DAG 表达不了且会退化成
  "用 JSON 写蹩脚语言"。多任务扇出调度是另一个靠后的独立问题（revengers territory），
  不混进 flow 生成。
- **三道护栏**（codegen 的安全/可靠地基，复用 flowcast 已有能力）：
  1. 约束式 codegen——只用 flowcast 词汇表 + 固定骨架模板，LLM 只填 `main()` 编排逻辑。
  2. 跑前校验——`node --check` + import 白名单 + 假执行器 dry-run。
  3. 持久化 + 续跑锁定——生成文件落盘，resume 跑同一份，绝不中途重生成。

## 目标

把"动态生成 flow"做成可控、可审计、可复现的 codegen harness：

1. 给出 **Flow API 契约**（生成的 flow 能用的 flowcast 词汇表）+ **骨架模板**（固定调用约定）。
2. flowcast 提供 **dry-run 能力**：假执行器 + 假质量门，让任意 flow 能零成本跑骨架（价值外溢，
   不止给 codegen 用）。
3. `validateFlow(file)`：语法 + import 白名单 + dry-run 三关校验。
4. `generateFlow(request)`：受控生成 → 写文件 → validateFlow → 失败回喂错误重生成一次。
5. `runGeneratedFlow(file, runId)`：子进程隔离执行 + Checkpoint + 续跑锁定。

## 非目标

- **不做多任务扇出调度 / DAG / 持久任务队列**（那是 revengers 已有的 SQLite reconciliation，
  靠后再谈接入）。
- **不做完整 VM 级沙箱**：第一版"信任但校验"——import 白名单 + dry-run + 生成 flow 本身又跑在
  `withSelfModGuard` git worktree 沙箱里（双层）。
- **不改 L1/L2 既有原语的对外语义**（dry-run 是新增旁路，默认关闭）。
- 不碰 revengers 仓。

## Definition of done

- `orchestrator/` 模块：契约文档 + 骨架模板 + 黄金样例 + validateFlow + generateFlow + runGeneratedFlow。
- flowcast dry-run 能力有单测；validateFlow 有单测（含一个故意违规样例被拦截）。
- 端到端：一个简单需求 → 生成 → 校验 → dry-run → 真跑（M5）。
- 全量 `npm test` 绿。
