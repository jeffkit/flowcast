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

## M3 — generateFlow（✅）

- `orchestrator/paths.js`：抽出 FLOW_SKELETON/GOLDEN_SAMPLE/FLOW_API_DOC 路径常量，破 index↔generate 循环依赖。
- `orchestrator/generate.js`：
  - `extractCode`（抓 ```js 代码块 / 裸文本）、`buildGenPrompt`（契约 + 黄金样例 few-shot + 可用 agents + 失败回喂）。
  - `generateFlow(request, {repo, runDir, agent, agents, providers, generate, maxAttempts})`：
    生成 → 写 `runDir/flow.mjs`（.mjs 保 ESM）→ validateFlow → 失败把 error 回喂重生成（默认重试 1 次）。
    `generate` 可注入（测试用 fake，不烧 API）。
- 单测：好代码一次过 / 首次违规回喂后修正（attempts=2）/ 始终违规 ok=false。

## M4 — runGeneratedFlow + git helper（✅）

- `git.js`（解待解项）：`gitStatus` / `gitDiff` / `gitCommitAll`（dry-run 不实际提交），从 index 暴露；
  生成的 flow 通过 `@force-lab/flowx` import 即可 commit，无需裸调 child_process。FLOW_API.md 已登记。
- `orchestrator/run.js`：
  - `runGeneratedFlow(file, opts)`：`node <file>` spawn 子进程跑（隔离 + 超时 kill + 崩溃不污染宿主）。
  - `orchestrate(request, opts)`：需求 →（生成 or 复用）→ 执行；**续跑锁定**——run 目录已有 flow.mjs
    则跑同一份、绝不重生成；request 持久化到 runDir。
- 单测：子进程 dry-run 黄金样例 exit 0；git helper 提交/跳过/dry-run。

## M5 — 端到端（✅）

- `orchestrate` e2e 单测：需求 → fake 生成 → 校验 → dry-run 子进程真跑（exit 0）；
  同 runId 再跑 → reused=true、generate 不被调用（续跑锁定验证）。

## 测试

全量 76 全绿（57 → 76，+19）。M1+M2 commit 2cc9a74；M3-M5 本次提交。

## 踩坑

- `node --check` 对无 `package.json` 的 `.js` 按 CJS 判定，语法错误漏过 → 改用 `.mjs` 副本校验。
- dry-run 需容忍「未配置的 agent」否则结构冒烟在 loadAgents 为空时即崩 → resolveAgent dry-run 分支返回 fake。
- `@force-lab/flowx` 自引用按「文件所在包作用域」解析（与 cwd 无关）→ 生成的 flow 文件必须落在装了
  flowx 的项目内（或仓内）才能 import 到。
