# plan.md — flowcast 自我迭代引擎（Step 1）里程碑

> 读 prompt.md 冻结目标后制定。每个里程碑有验证命令。E2E checkpoint 标在 M7。

## 设计映射：self-improve.sh → flowcast 原语

| self-improve.sh 的机制 | 迁移到 flowcast 的承载 |
|---|---|
| git baseline 预检 + clean 检查 + EXIT trap 回滚 | `withSelfModGuard`（M2） |
| 跑 recursive 二进制（run / replay --resume-from） | `recursive` adapter（M1） |
| BudgetExceeded 自动 resume（一次） | `recursive` adapter + flow 编排（M1+M6） |
| cargo test / clippy / fmt / E2E smoke 门控 + resume-fix | `qualityGate` runner（M3） |
| 跨 provider self-review（review-changes.sh） | flow 内一步，复用 recursive adapter（M6） |
| 失败上下文写入 + 下次注入 system prompt | failure-context / 最小 learnings（M5） |
| provider 选择/轮转 + complexity hint | flow 内配置层（M6） |
| metrics YAML + observation + READY TO LAND | flow + Checkpoint 报告扩展（M6/M7） |
| READY TO LAND / 升级人工 | 可插拔 HITL backend（M4） |
| parallel-self-improve.sh（worktree-per-run） | `withSelfModGuard` 的 worktree 选项 + flowcast parallel（后续） |

## 里程碑

### M1 — recursive 执行器 adapter
- 在 `agent.js` 加 `recursive(prompt, opts)`，并注册进 `CLI_MAP`。
- 支持：`--workspace`、`--system-prompt-file`、`--transcript-out`、`--pricing-file`、`--log`、`run <goal>`、`replay <transcript> --resume-from N`。
- 返回字符串结果，附 `_meta`：exitCode、是否 `BudgetExceeded`（从输出 grep `reason: BudgetExceeded`）、transcript 消息数（读 transcript JSON `.messages.length`）。
- **验证**：`node test/recursive-adapter.test.js`（用一个假的 `recursive` stub 二进制 / mock spawn 验证参数拼装与输出解析）。

### M2 — withSelfModGuard 原语 ⭐
- 新文件 `self-mod-guard.js`，导出 `withSelfModGuard(fn, { repo, baseline?, worktree?, allowlist? })`。
- 行为：捕获 baseline（无 baseline commit → 抛错）；要求 clean（脏 → 抛错）；运行 `fn`；`fn` 抛错或返回失败 verdict → `git reset --hard baseline` + `git clean -fd`；成功 → 由调用方决定 commit；panic 信号（约定 verdict='panic'）→ 不回滚，保留诊断。
- **验证**：`node test/self-mod-guard.test.js`（在临时 git 仓里验证：脏树拒绝、失败回滚到 baseline、成功保留改动、panic 保留）。

### M3 — qualityGate runner
- 新文件 `quality-gate.js`，导出 `runGate({ name, cmd, cwd, onFail })` 和 `runGates([...])`。
- `onFail` 策略：`rollback`（抛出让 guard 回滚）、`resume-fix`（调用传入的 resume 回调给 agent 一次修复机会后重测）、`autofix`（跑修复命令如 `cargo fmt --all` 后继续，不回滚）。
- **验证**：`node test/quality-gate.test.js`（mock 命令的成功/失败/修复后成功三路）。

### M4 — 可插拔 HITL backend
- 改 `agent.js` 的 HITL：`setHitlBackend('terminal'|'wecom')` + `waitForInput(prompt)` / `notify(msg)` 路由到对应后端。
- `wecom` 后端通过约定的桥（CLI 包装或环境变量传入 chat_id / project_name）调用 send_and_wait_reply / send_message_only。
- **验证**：`node test/hitl-backend.test.js`（terminal 用 mock stdin；wecom 用 mock 发送函数断言被正确调用）。

### M5 — failure-context（最小 learnings）
- 新文件 `failure-context.js`：`writeFailureContext(dir, tag, {reason, tailLog})` 与 `readAndConsumeFailureContext(dir, tag)`（读后删，保证只注入一次）。
- **验证**：`node test/failure-context.test.js`（写入→读取→二次读取为空）。

### M6 — flows/recursive-self-improve.js
- 编排 M1–M5：goal 解析（文件/inline）+ complexity hint（`## Complexity: hard` → pro tier + 双倍 budget）+ provider 选择/轮转 + 构建 system prompt（AGENTS.md + 最近 journal + 失败上下文）+ 跑 agent + auto-resume + 质量门 + self-review（跨 provider，最多 2 轮修订）+ verdict（committed/rolled-back/skip-commit/panic-preserved）+ metrics + observation + READY TO LAND。
- 全程用 `cp.step()` 包裹，落 state.json / jsonl。
- **验证**：`node flows/recursive-self-improve.js --list` 正常；dry-run（mock recursive adapter）跑通完整状态机。

### M7 — 真实 parity 验证（E2E checkpoint）
- 在 recursive 仓选一个 easy goal，跑 `flows/recursive-self-improve.js`，确认：verdict 与 `self-improve.sh` 一致、回滚干净、commit 形态一致、`.flowcast/runs/<id>/` 审计齐全。
- 在 flowcast `EVALUATION.md` 追加一条运行记录。
- **E2E checkpoint**：是。

## 风险与缓解

- **过早抽象僵化** → 原语只固化 self-improve.sh 已验证有效的行为，差异点留 opts 开关，不预设 revengers 需求。
- **recursive 二进制契约变化** → adapter 只依赖稳定 CLI 参数（run/replay/transcript-out），不依赖内部实现。
- **E2E 依赖 argusai/Docker** → 与 self-improve.sh 一致，缺失时 HARD FAIL 或显式 `RECURSIVE_SMOKE_TEST=0` 跳过。
