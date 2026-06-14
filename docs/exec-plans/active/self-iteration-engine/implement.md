# implement.md — flowcast 升级为「自我迭代流程引擎」（Step 1 执行日志）

> 执行日志，按里程碑追加。AI 恢复上下文请先读 status.md。

## M1 recursive 执行器 adapter（agent.js）✅

- 新增 `spawnCapture(cmd, args, opts)`：捕获式 spawn，**不因非零退出码 reject**（recursive 的 exit code 是数据不是错误），合并 stdout+stderr，返回 `{ stdout, exitCode, timedOut, spawnError }`。
- 新增 `resolveRecursiveBin(cwd)`：优先 `target/release/recursive`，其次 debug，最后回退 PATH。
- 新增 `recursive(goal, opts)` adapter：支持 `run` / `replay --resume-from N`、`--workspace`/`--system-prompt-file`/`--transcript-out`/`--pricing-file`/`--provider`/`--model`/`--api-key`/`--api-base`/`--max-steps`/`--log`/`--allow-tools`；解析 `_meta`（exitCode、budgetExceeded、finishReason、panicked、transcriptMessages、spawnError、timedOut）。
- 注册进 `CLI_MAP`。
- 校验点：recursive CLI 全局 flag 在子命令前；replay 形如 `replay <PATH> --resume-from N <goal>`，与真实二进制一致。

## M2 withSelfModGuard（self-mod-guard.js）✅

- `captureBaseline(repo, {requireClean})`：要求 HEAD 存在；requireClean 时要求工作树干净。
- `withSelfModGuard(fn, {repo, requireClean, baseline, clean})`：fn 抛错或 verdict='rolled-back' → `git reset --hard baseline` + `git clean -fd`；panic-preserved/skip-commit/committed 不回滚。

## M3 qualityGate runner（quality-gate.js）✅

- `runGate(gate, deps)`：onFail `rollback`（抛错交 guard 回滚）/ `resume-fix`（失败喂回 agent 修一次再测）/ `autofix`（跑确定性修复命令，如 fmt）。
- `runGates(gates, deps)`：顺序执行，遇红灯即抛。

## M4 可插拔 HITL backend（agent.js）✅

- `terminalBackend`（readline）+ `makeWecomBackend`（注入 sendAndWait/send 或 mcp2cli 调 wecom-hil MCP）。
- `setHitlBackend / getHitlBackend / waitForInput / notify`。

## M5 failure-context（failure-context.js）✅

- `writeFailureContext(dir, tag, {reason, tailLog, provider, model})`：on-fail 写结构化 md。
- `readAndConsumeFailureContext(dir, tag)`：读取即删除（只注入一次）。

## M6 flows/recursive-self-improve.js ✅

- 编排：`ensureGitExclude(.flowcast/)`（worktree 用 `--git-common-dir`）→ `preflight.baseline`（持久化续跑复用）→ `preflight.system-prompt`（注入 AGENTS.md/CLAUDE.md + 最近 journal + failure-context）→ `withSelfModGuard` 包裹整个 attempt：
  - `run.recursive` → panic 则 panic-preserved；BudgetExceeded 自动 resume 一次（独立 transcript）。
  - 无改动 → skip-commit。
  - 质量门 test/clippy/fmt（clippy 用 `--all-targets --all-features`；fmt 走 autofix）。
  - 跨 provider self-review（`reviewWithRetry`：PASS / NEEDS_FIX / UNAVAILABLE 三态）。
  - 全绿 → commit "self-improve: <goal>"。
- provider 走命名 profile（`PROVIDER_PROFILES`，忠实复刻 self-improve.sh 的 apply_provider_profile）经 env 注入 recursive（RECURSIVE_PROVIDER_TYPE/API_BASE/MODEL/API_KEY）。
- pricing 走 `.dev/pricing.yaml`；新增 `--bin` 让 worktree 复用 main 的预编译二进制。
- 收尾：computeMetrics（files_changed/verdict）+ cp.done + announce（committed→READY TO LAND；其他→HITL notify）。

## M7 真实 parity 验证（deepseek，count_lines goal）✅

隔离 worktree：`~/projects/recursive/.worktrees/count-lines-parity`，分支 `self-improve/count-lines-deepseek-20260611T145956`，baseline 649a452。

| run | 配置 | verdict | 说明 |
|-----|------|---------|------|
| run-3 | review on | rolled-back | reviewer 命中 deepseek 瞬时网络错误 → 回滚（干净）。暴露发现 1。 |
| run-4 | review on | rolled-back | agentic reviewer 跑偏探索、结束无 VERDICT 行 → 保守判否回滚（干净）。暴露发现 2。 |
| run-5 | --no-review | **committed** | commit cf0b9b2，3 文件，质量门全绿，READY TO LAND。 |

- 回滚干净度验证 ×2：HEAD 回 baseline、工作树 clean、新文件被删。
- 审计产物齐全：state.json / run.log.jsonl / report.md / transcript.json / system-prompt.md / failure-context.md。
- 总 API 成本约 $0.14。

### 两个真实发现

1. **reviewer 瞬时错误 ≠ NEEDS_FIX**：已修。`reviewWithRetry` 区分 PASS / NEEDS_FIX / UNAVAILABLE；UNAVAILABLE（多次调用出错）→ 不丢弃成果，skip-commit 保留 + HITL 升级。
2. **agentic reviewer 需强约束**：给了工具就跑偏成 worker、结束不吐结构化 verdict（这正是 recursive 自己用 `review-changes.sh` JSON verdict 的原因）。下一步：给 review 加「限步数 + 强制结构化 verdict 提取（resume 追问 only-verdict）」。
