# status.md — L3 Codegen Harness（AI 恢复入口）

> 先读本文件，再读 implement.md / plan.md / prompt.md。

**最后更新**：2026-06-11
**分支**：`feat/self-iteration-engine`（flowx 仓）
**整体状态**：🟢 M1-M5 全部完成；L3 codegen harness MVP 闭环

## 方向（kongjie 已拍板）

- L3 放 flowx 内（`orchestrator/`）。
- **codegen 为唯一主路径**，生成 flow 代码（与人手写同构）。
- **不做 DAG**：真实 flow 是命令式控制流；多任务扇出调度是另一个靠后的独立问题。
- 三护栏：约束式 codegen（词汇表+骨架）／跑前校验（语法+import白名单+dry-run）／持久化+续跑锁定。

## 进度

| 里程碑 | 状态 |
|--------|------|
| M1 契约 + 骨架 + 黄金样例 | ✅ |
| M2 dry-run 能力 + validateFlow + 单测 | ✅ |
| M3 generateFlow（受控生成→写文件→validate→重试一次） | ✅ |
| M4 runGeneratedFlow（子进程隔离 + 续跑锁定）+ git helper | ✅ |
| M5 端到端（需求→生成→校验→dry-run→真跑） | ✅ |

- 全量测试 76 全绿。

## 新增文件（flowx 仓）

- `dry-run.js`、`git.js`
- `orchestrator/{FLOW_API.md,index.js,paths.js,validate.js,generate.js,run.js}`、
  `orchestrator/templates/flow-skeleton.js`、`orchestrator/examples/golden-sample.flow.js`
- `test/{dry-run,orchestrator-validate,orchestrator-codegen,git}.test.js`
- 改：`executor.js`（dry-run 分支）、`quality-gate.js`（dry-run 判过）、`index.js`（导出 isDryRun + git）、`package.json`

## 对外 API（codegen harness）

```js
import { generateFlow, validateFlow, runGeneratedFlow, orchestrate } from '@force-lab/flowx/orchestrator/...'
// orchestrate(request, { repo, runId, agent, agents, providers, generate?, dryRun }) —— 一站式：生成→校验→执行，续跑锁定
```

## 后续（真实 L3，非本 MVP）

1. 用真实 agent（claude/recursive）跑一次真生成（非 fake），观测生成质量；按需补 few-shot。
2. 多任务扇出调度（revengers SQLite reconciliation territory）——独立、靠后。
3. dry-run 对 withSelfModGuard/git 目前 temp repo 内真跑；若要纯内存 dry-run 再议。
