# implement.md — L3 Codegen Harness 实现日志

## M1 — 契约 + 骨架 + 黄金样例（✅）

- `orchestrator/FLOW_API.md`：codegen 词汇表 + 标准 CLI 约定（`--repo/--run-id/--goal/--dry-run/…`）+
  允许原语清单 + 禁止项（非白名单 import、任意 fs/进程/网络、main() 外副作用）。
- `orchestrator/templates/flow-skeleton.js`：固定骨架，imports 仅 `@force-lab/flowx`+`util`，
  处理 parseArgs/Checkpoint/loadAgents/HITL/`runProfile`，`main()` 内留 `// <<ORCHESTRATION>>`。
- `orchestrator/examples/golden-sample.flow.js`：并行多 agent 分析 → 质量门 → 综合收口；
  100% 遵循契约。
- 验证：`@force-lab/flowx` 自引用（package exports + name）在仓内可解析；临时 git repo dry-run
  跑通（analyze/gate.lint/synthesize 步骤、fake 执行器/质量门、notify），exit 0。

## M2 — dry-run 能力 + validateFlow（✅）

- `dry-run.js`：`isDryRun(env)`（`FLOWX_DRY_RUN`），导出到 index。
- `executor.js`：dry-run 时 `resolveAgent().run` 返回 fake 成功（`_meta.dryRun`）；未知 agent 也给
  fake runner（结构冒烟不校验配置齐全）；**provider-locked 校验恒做**（dry-run 也拦 cursor+provider）。
- `quality-gate.js`：dry-run 时 `runGate` 直接判过，不 spawn。
- `orchestrator/validate.js`：`validateFlow(file)` 三关——
  ① 语法（复制成 `.mjs` 再 `node --check`，规避 .js 按 CJS 判定过松的坑）；
  ② import 白名单（`scanImports` 抓 static/bare/动态 import + require）；
  ③ 假执行器 dry-run（一次性 git repo 跑 `node <file> --dry-run`，断言 exit 0）。
- 单测：`test/dry-run.test.js`（5）+ `test/orchestrator-validate.test.js`（5）。
  含违规样例被拦（语法错 / import fs）、回归保护（非 dry-run 门失败仍抛）。

## 测试

全量 67 全绿（57 → 67，+10）。

## 踩坑

- `node --check` 对无 `package.json` 的 `.js` 按 CJS 判定，语法错误漏过 → 改用 `.mjs` 副本校验。
- dry-run 需容忍「未配置的 agent」否则结构冒烟在 loadAgents 为空时即崩 → resolveAgent dry-run 分支返回 fake。
