# L3 编排（orchestrate）

L3 是 flowcast 最高的一层：**接单 → 动态生成 flow 代码 → 校验 → 执行（续跑锁定）**。它类似但超越 Claude Code 的 `/workflow`——它是**跨 coding agent** 的。

## 核心决策：codegen 唯一主路径，不做 DAG

L3 **直接生成 flow 代码**（与人手写同构），不引入 DAG 抽象。flow 逻辑本质是命令式的（条件 resume、budget 重试、verdict 分支），用代码表达天然、可读、可 dry-run 校验；DAG 反而要为这些控制流再造一套表达。

## 护栏三件套

```
① 约束式生成   词汇表（FLOW_API.md）+ 骨架（flow-skeleton.js）+ 黄金样例（golden-sample.flow.js）
② 跑前校验     语法（node --check）+ import 白名单（只许 flowcast + util）+ dry-run 冒烟
③ 持久化+续跑   生成的 flow.mjs 落盘到 .flowcast/runs/<run-id>/，续跑直接复用，绝不重生成
```

生成的 flow **只能** import `flowcast`（+ `util`），只能用 [FLOW_API](/api/) 列出的原语。需要 git / 文件 / 进程操作时，只能通过 flowcast 暴露的原语（`gitCommitAll`、`runFlow`…），不能裸调 `child_process` / `fs`。`validateFlow` 会拦截违规。

## 单 flow 模式

一行需求，端到端跑通：

```bash
flowcast orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet
```

执行流程：

1. **预检** `checkFlowcastResolvable`：目标仓必须能解析 `flowcast`，否则毫秒级 fail-fast 并给出 `npm install` 指引。
2. **生成或复用**：`.flowcast/runs/<run-id>/flow.mjs` 已存在则**续跑锁定**（直接跑同一份）；否则用真实 agent 生成 → 校验。
3. **隔离执行**：子进程跑 `flow.mjs`，崩溃不污染宿主。

```bash
# 续跑：复用已生成的 flow.mjs（绝不重新生成）
flowcast orchestrate "..." --run-id orch-123

# dry-run：生成阶段仍走真实 agent（无法凭空伪造合法代码），
# 但生成的 flow 子进程以 FLOWCAST_DRY_RUN 运行（执行器/质量门被 fake）
flowcast orchestrate "..." --dry-run
```

## 接单分拆模式（--split）

大目标先**分拆成子任务清单**，每个子任务生成一条 flow，再 `fanOut` 并发执行：

```bash
flowcast orchestrate "把 README 的 TODO 全部实现" --split --concurrency 3
```

执行流程（两段都续跑锁定）：

1. **分拆**：LLM 受控分拆大目标 → 校验过的子任务清单（`tasks.json`，刻意不做 DAG）。已存在则复用。
2. **逐个生成 flow**：每个子任务在 `sub/<name>/flow.mjs` 生成 + 校验。已存在则复用。
3. **fanOut 并发执行**：worktree 隔离 + 每任务日志 + 续跑由各子 flow 的 `--run-id` 负责。

```bash
# 不做 worktree 隔离（原地跑）
flowcast orchestrate "大目标" --split --inplace
```

手写编排（自定义 flow 里直接调 `fanOut`）与 LLM 分拆（`orchestrateMulti`）**共用 `fanOut` 这一底座**。

## CLI 参数

| 参数 | 含义 |
|------|------|
| `<goal>` / `--goal` | 目标描述（位置参数或 flag） |
| `--repo` | 目标仓路径（默认 cwd） |
| `--run-id` | run 标识（续跑必须传同一个） |
| `--agent` | 默认 agent profile 名 |
| `--dry-run` | 生成真实进行，执行用 fake 执行器/质量门 |
| `--hitl` | `terminal`（默认）/ `wecom`，透传给生成的 flow |
| `--project-name` | HITL 用的项目名 |
| `--split` | 接单分拆模式 |
| `--concurrency` | 分拆模式并发度（默认 2） |
| `--inplace` | 分拆模式不做 worktree 隔离 |
| `--timeout` | 子 flow 超时 ms |

## 编程式调用

```js
import { orchestrate, orchestrateMulti, loadAgents, loadProviders } from 'flowcast'

const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])

// 单 flow
const r = await orchestrate('审计 src/ 并修 lint', { repo, agents, providers, agent: 'claude-sonnet' })
// → { ok, stage, file, reused, attempts, exitCode, stdout, stderr }

// 接单分拆
const m = await orchestrateMulti('实现 README 全部 TODO', {
  repo, agents, providers, concurrency: 3, isolate: 'worktree',
})
// → { ok, stage, runId, tasks, results }
```

## 生成产物结构

```
.flowcast/runs/orch-123/
├── flow.mjs        # 生成的 flow（续跑复用这一份）
├── request.txt     # 原始需求
├── state.json      # checkpoint 状态
└── run.log.jsonl   # 完整审计日志

# --split 模式额外有：
├── tasks.json      # 分拆出的子任务清单
└── sub/<name>/flow.mjs  # 每个子任务的 flow
```
