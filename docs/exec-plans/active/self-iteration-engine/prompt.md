# prompt.md — flowcast 升级为「自我迭代流程引擎」（Step 1 试金石）

> 冻结目标。本文件一旦确认不再随意改动；范围调整需显式记录。

## 背景

flowcast / recursive / revengers 三个项目在不同层次/语言上独立逼近同一个命题：**能自主、安全、持续改进软件（含改自己）的 AI 工程闭环**。其中 recursive(Rust) 与 revengers(JS) 在「AI 改 AI」最危险环节各自独立收敛到几乎相同的解法（worktree 隔离 + 测试门控 + 失败回滚 + 合并守门），这是该范式真实存在的最强证据。

目标架构是清晰的三层：

- **L3 编排/调度层**（revengers 大脑）：接单 → 分拆 → 动态生成 flow 代码 → 调度。跨 coding agent。本步**不做**。
- **L2 流程引擎**（flowcast）：执行单个固化 flow，提供 checkpoint / 审计 / 可观测 / 自改沙箱 / 质量门 / HITL。**本步聚焦此层。**
- **L1 执行器**（coding agents）：claude / cursor / recursive-kernel / gemini / codex，可替换工人。

## 本步目标（用户视角）

把 recursive 的 `self-improve.sh`（49KB bash 自改循环）忠实迁移成一个 flowcast JS flow（`flows/recursive-self-improve.js`），过程中把它依赖的、目前缺失的通用能力**长成 flowcast 的一等公民原语**。让 recursive 的自我迭代流程从「不可审计的 bash」变成「可审计、可观测、可断点续跑、可迭代的 JS flow」。

recursive 作为试金石的理由：它的自改循环是纯编排 meta-tooling（无运行时状态机），迁移纯赚，且能逼出 flowcast 真正该有的原语，为后续 (B) 协议规范和 revengers 选择性接入打基础。

## 完成标准（每条可验证）

1. **flowcast 新增 4 个一等公民原语，各自带单测且通过**：
   - `recursive` 执行器 adapter（`agent.js`）：支持 `run` / `replay --resume-from N`、`--system-prompt-file`、`--transcript-out`、`--pricing-file`；返回结果并暴露 exit code、是否 `BudgetExceeded`、transcript 消息数。
   - `withSelfModGuard(fn, opts)`：baseline 捕获 + clean 检查 + 失败 `git reset --hard` + `git clean` 回滚 + 成功 commit + panic 保留（不回滚留作诊断）。
   - `qualityGate` runner：声明式 `{ name, cmd, onFail: 'rollback'|'resume-fix'|'autofix' }`，按策略处理红灯。
   - 可插拔 HITL backend：`waitForInput` 支持 `terminal` 与 `wecom`（企微）两种后端，`wecom` 复用 send_and_wait_reply / send_message_only。
2. **`flows/recursive-self-improve.js` 能在 recursive 仓跑通一个真实 easy goal**，行为对齐 `self-improve.sh` 关键路径：baseline/clean 预检 → 构建 system prompt（注入 AGENTS.md 契约 + 最近 journal + 上次失败上下文）→ 跑 recursive 二进制 → BudgetExceeded 自动 resume（一次）→ 质量门（test/clippy/fmt/E2E，各带一次 resume-fix）→ 跨 provider self-review → verdict（committed / rolled-back / skip-commit / panic-preserved）。
3. **失败回滚干净**：任意 gate 红灯或异常退出后，工作树恢复到 baseline（`git status` clean）。
4. **断点续跑**：流程被中断后，能从最近未完成步骤继续，已完成步骤零重复执行（依赖 flowcast Checkpoint）。
5. **全程可审计可观测**：`.flowcast/runs/<id>/` 下有 `state.json` + `run.log.jsonl` + `report.md`，并额外产出 per-run metrics（steps/tokens/cost/files/test_pass/review verdict/wall time）。
6. **不改 recursive 的 Rust kernel 一行**；recursive 二进制仅作为被调度的执行器。
7. **READY TO LAND / 失败 升级**：成功时输出可落地指针（branch/worktree/merge 命令）；连续失败或需人工介入时通过企微 HITL 通知。

## 非目标（至少三条）

1. **不吞 revengers 的运行时**（SQLite 状态机 / daemon / 单实例 lock / dashboard）——这些是 L3 实现细节，留在 revengers。
2. **不实现 L3 动态编排**（接单/分拆/动态生成 flow/调度）——本步只做 L2 + 单 flow 执行。
3. **不做完整 learnings RAG**——只做 failure-context 的「写入 on-fail + 注入 on-retry」最小形态，完整 RAG 召回留后续。
4. **不强行统一三项目**——差异点标注为「实现选择」，不为统一而统一。
5. **不动 recursive 产品源码**——只在 flowcast 侧加能力 + 新增 flow 文件。

## 验收方式

在 recursive 仓选一个低风险 easy goal，分别用 `self-improve.sh` 与 `flows/recursive-self-improve.js` 各跑一次，对比：verdict 一致、回滚行为一致、产出 commit 形态一致；flowcast 版额外具备 state.json 续跑能力与结构化审计。
