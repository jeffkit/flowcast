# status.md — flowx 自我迭代引擎 Step 1（AI 恢复入口）

> AI 恢复上下文先读本文件，再读 implement.md / plan.md / prompt.md。

**最后更新**：2026-06-11
**分支**：`feat/self-iteration-engine`（flowx 仓，已提交 c08a6a9 / 24cd851 + provider 标准化）
**整体状态**：🟢 Step 1 完成并提交；count_lines review=PASS；provider profile 已标准化（消除硬编码泄露）

## 进度

| 里程碑 | 状态 |
|--------|------|
| M1 recursive adapter（agent.js）+ 单测 | ✅ |
| M2 withSelfModGuard（self-mod-guard.js）+ 单测 | ✅ |
| M3 qualityGate runner（quality-gate.js）+ 单测 | ✅ |
| M4 可插拔 HITL backend（terminal/wecom）+ 单测 | ✅ |
| M5 failure-context（failure-context.js）+ 单测 | ✅ |
| M6 flows/recursive-self-improve.js 编排 | ✅ |
| M7 真实 parity（deepseek，count_lines）E2E | ✅ |

- 单测：28 个全绿（含 2 个结构化 E2E：committed + rolled-back 双路径，不烧 API）。
- 真实 parity：verdict 矩阵全验（committed×1 + rolled-back×2），回滚干净、审计产物齐全、commit 形态对齐 self-improve.sh。

## 新增文件（flowx 仓）

- `self-mod-guard.js` / `quality-gate.js` / `failure-context.js`
- `flows/recursive-self-improve.js`
- `test/{agent,self-mod-guard,quality-gate,failure-context,flow-e2e}.test.js`
- `agent.js`（新增 recursive adapter + 可插拔 HITL）、`index.js`（导出）、`package.json`（test 脚本 + files）

## kongjie 决议（2026-06-11）

- **A) count_lines review**：由 AI 来 review（已完成）。verdict=**PASS**——代码遵循 ReadFile 模式、sandbox 正确、2 单测覆盖、改动面最小（3 文件）。分支 `self-improve/count-lines-deepseek-20260611T145956` commit cf0b9b2 merge-ready。recursive main 当前有无关脏文件（permission_pipeline.rs），合并时机/由谁合留 jeffkit/kongjie 定，未自动合入。
- **B) review 健壮化**：写成 goal，晚点另一个 session 让 self-improve workflow 自己做 → 已写 `.dev/goals/001-self-review-structured-verdict.md`。
- **C) 提交 Step 1 成果到 flowx feat 分支**：已提交（c08a6a9）。

## Provider profile 标准化（2026-06-11，kongjie 拍板「现在做」）

把「执行器 adapter（怎么驱动 CLI）」与「provider 配置（哪个模型/端点/密钥）」彻底分层，
借鉴 ilink-hub bridge profile 的 `${VAR}` 插值规范，flowx 仓内不再有任何端点/密钥。

- **新增 `provider.js`**：`interpolateEnv`（${VAR}，缺失 fail-fast，$$ 转义）+
  `loadProviders`（~/.flowx + <repo>/.flowx 多层合并，支持 json/yaml/js）+
  `resolveProvider`（name → 通用 bundle，兼容旧 base/keyEnv 字段）。
- **agent.js 新增 `recursiveProviderEnv`**：通用 bundle → `RECURSIVE_*` env（recursive 协议知识归 adapter）。
- **flow 删除 `PROVIDER_PROFILES` 硬编码**：改为 `loadProviders → resolveProvider → recursiveProviderEnv`。
- **配置外置**：profiles 迁到 `~/.flowx/providers.json`（机器级，密钥 `${VAR}`）；仓内留 `examples/providers.example.json`。
- 单测：provider.test.js 17 个；全量 45 个全绿。冒烟验证解析链路 OK。

分层结论（对齐 L1/L2/L3）：
- L2 引擎内核 / L1 adapter / provider schema+resolver → **flowx 库**（通用）。
- 项目特定 flow 配置（质量门、provider 名）→ **项目仓 `.flowx/`**（committed，小文件）。
- 机器级状态+密钥（run checkpoints、API key）→ **`~/.flowx/`** 或 gitignore 的 `.flowx/`。

## 执行器能力分层 + agent profile 绑定层（2026-06-11，kongjie 拍板「先做能力分层」）

解决「provider 只是 LLM 配置，但执行器本身分 BYO / 锁定两类」的问题。执行器是否接受外部
provider 由「有没有 applyProvider 翻译器」派生（单一事实来源）。

- **新增 `executor.js`**：
  - `EXECUTORS` 注册表：recursive/aider/claude 带 applyProvider（BYO）；cursor/gemini/codex 无（锁定）。
  - applyProvider 翻译器：recursive→`RECURSIVE_*` env、claude→`ANTHROPIC_*` env+model、aider→`OPENAI_*` env+model。
  - `getExecutor`（acceptsProvider 派生）、`loadAgents`（多层合并）、`resolveAgent`（绑定+校验）。
  - **关键校验**：给锁定型执行器（cursor 等）配 provider → fail-fast，提示改用自带 model。
- **provider.js** 抽出通用 `loadMergedConfig` + `basenamesFor`，providers/agents 共用多层加载。
- 配置：`examples/agents.example.json`（recursive-deepseek / claude-sonnet / cursor-default 三例）。
- 单测：executor.test.js 12 个；全量 57 全绿。冒烟验证绑定链路 + 锁定校验 OK。

模型总览（对齐 ilink）：ilink 把每个 profile 当自包含执行器；flowx 只为 BYO 执行器多加
provider 层，对 cursor 这类锁定执行器行为与 ilink 一致（只认自带 type/model）。

## 收尾：合并 main + recursive 专属内容归位（2026-06-11，kongjie 拍板）

- **flowx feat 分支合入 main**：保留通用原语 + L1 adapter + provider/agent + orchestrator(L3)。
- **recursive 专属内容迁到 recursive 仓**（flowx 不再持有）：
  - `flows/recursive-self-improve.js` → `recursive/.dev/flows/self-improve.flow.js`（import 改为 `@force-lab/flowx`）
  - `test/flow-e2e.test.js` → `recursive/.dev/flows/test/e2e.test.js`
  - `.dev/goals/001-self-review-structured-verdict.md` → `recursive/.dev/flows/goals/`
  - 新增 `recursive/.dev/flows/{package.json(file: 依赖 flowx),.gitignore,SELF_IMPROVE.md(AI 指引)}`
  - recursive 仓内 `npm install` + `npm test` 双 E2E 全绿，验证库消费路径成立。
- flowx 内 `agent.test.js`（recursive adapter，通用）保留。

## 已知下一步（不阻塞）

1. review 健壮化：goal 已随 flow 迁至 `recursive/.dev/flows/goals/001-self-review-structured-verdict.md`（留给 dogfooding）。
2. 内置通用 flow（selfImprove preset）——**kongjie 决定先放**。
3. **L3 动态编排**——已落地 codegen harness（orchestrator/）；后续接单→分拆→动态生成 flow→跨 executor 调度。

## 现场（未做任何破坏性操作）

- recursive 仓 main 未动；count_lines 改动仅在隔离 worktree 的特性分支上。
- flowx 仓改动已提交 feat 分支。
