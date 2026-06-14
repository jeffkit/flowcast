# plan.md — L3 Codegen Harness 里程碑

> 目标冻结见 prompt.md。本文件列里程碑与验收点。

## 模块布局（flowcast 仓）

```
orchestrator/
  FLOW_API.md            # 生成的 flow 能用的 flowcast 词汇表 + 调用约定（契约）
  templates/
    flow-skeleton.js     # 固定骨架：imports + parseArgs(标准 args) + main() 占位
  examples/
    golden-sample.flow.js # 手写黄金样例：既当 few-shot，又当 dry-run 验证靶子
  validate.js            # validateFlow(file)：node --check + import 白名单 + dry-run
  generate.js            # generateFlow(request, ctx)：受控生成 → 写文件 → validate → 重试一次
  run.js                 # runGeneratedFlow(file, runId)：子进程隔离 + checkpoint + 续跑锁定
  index.js               # 对外 API
```

dry-run 能力落在 flowcast 核心（executor.js / quality-gate.js），非 orchestrator 私有。

## 里程碑

### M1 — 契约 + 骨架 + 黄金样例
- `FLOW_API.md`：列出允许的原语（`cp.step`、`resolveAgent().run`、`runGate(s)`、`parallel`、
  `withSelfModGuard`、`waitForInput`/`notify`、`writeFailureContext`）；标准 CLI 约定
  （`--repo --run-id --goal --dry-run`）；禁止项（任意 fs/net/子进程、import 非白名单）。
- `templates/flow-skeleton.js`：可直接 node 跑的骨架，`main()` 内留 `// <<ORCHESTRATION>>` 占位。
- `examples/golden-sample.flow.js`：手写一个真实编排（如 run agent → gate → review → commit），
  100% 遵循契约，能被 M2 的 dry-run 跑通。
- 验收：黄金样例 `node --check` 通过；结构符合骨架约定。

### M2 — dry-run 能力 + validateFlow
- flowcast 核心加 dry-run（`FLOWX_DRY_RUN=1`）：
  - `executor.js`：dry-run 时 `resolveAgent().run` 返回 fake 成功（带 `_meta`），不调真 CLI。
  - `quality-gate.js`：dry-run 时 `runGate` 直接判过，不 spawn。
  - 提供 `isDryRun()` helper。
- `orchestrator/validate.js`：
  1. `node --check <file>`；
  2. import 白名单扫描（只准相对 import flowcast + 标准库白名单）；
  3. dry-run：临时 git repo 里 `node <file> --dry-run --repo <tmp> --goal <demo>`，断言 exit 0。
- 单测：dry-run fake 行为；validateFlow 对黄金样例通过、对故意违规样例（import fs 写盘 / 语法错）拦截。
- 验收：黄金样例过 validateFlow；违规样例被拦。

### M3 — generateFlow
- `generate.js`：用 `resolveAgent` 选的 agent + 系统提示（注入 FLOW_API.md + 黄金样例 few-shot +
  可用 agents 列表）生成 flow 文本 → 写 run 目录 → `validateFlow` → 失败把错误回喂 agent 重生成一次。
- 单测：用 fake agent backend（注入固定返回）验证生成→校验→重试链路，不烧 API。

### M4 — runGeneratedFlow + 持久化 + 续跑锁定
- `run.js`：`node <file>` spawn 子进程真跑，带 Checkpoint；request + 生成文件 + 所用 agent 落 run 目录；
  resume 跑落盘的同一份文件，绝不重生成。
- 单测：续跑读同一文件；子进程超时/崩溃处理。

### M5 — 端到端
- 一个简单需求 → generateFlow → validateFlow → dry-run → 真跑（可先 fake agent 或一个 easy 真实需求）。
- 验收：全链路跑通，审计产物齐全。

## 本轮范围

本次推进 **M1 + M2**（契约/骨架/样例 + dry-run 能力 + validateFlow）。M3-M5 后续。
