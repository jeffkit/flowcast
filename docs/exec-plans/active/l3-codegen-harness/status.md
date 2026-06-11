# status.md — L3 Codegen Harness（AI 恢复入口）

> 先读本文件，再读 implement.md / plan.md / prompt.md。

**最后更新**：2026-06-11
**分支**：`feat/self-iteration-engine`（flowx 仓）
**整体状态**：🟢 M1+M2 完成（本轮范围）；M3-M5 待续

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
| M3 generateFlow（受控生成→写文件→validate→重试一次） | ⬜ |
| M4 runGeneratedFlow（子进程隔离 + checkpoint + 续跑锁定） | ⬜ |
| M5 端到端（需求→生成→校验→dry-run→真跑） | ⬜ |

- 全量测试 67 全绿。

## 新增文件（flowx 仓）

- `dry-run.js`、`orchestrator/{FLOW_API.md,index.js,validate.js}`、
  `orchestrator/templates/flow-skeleton.js`、`orchestrator/examples/golden-sample.flow.js`
- `test/{dry-run,orchestrator-validate}.test.js`
- 改：`executor.js`（dry-run 分支）、`quality-gate.js`（dry-run 判过）、`index.js`（导出 isDryRun）、`package.json`（files）

## 下一步（M3）

`orchestrator/generate.js`：用 resolveAgent 选的 agent + 系统提示（注入 FLOW_API.md + 黄金样例
few-shot + 可用 agents 列表）生成 flow 文本 → 写 run 目录 → validateFlow → 失败回喂错误重生成一次。
单测用 fake agent backend（注入固定返回），不烧 API。

## 已知待解（非阻塞）

- 生成的 flow 若需 git commit，目前白名单禁 child_process → 需 flowx 暴露 git helper（M4 前补）。
- dry-run 对 withSelfModGuard/git 仍真跑（temp repo 内），未来若要纯内存 dry-run 再议。
