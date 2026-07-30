# orchestrate 闭环参考（生成 → 跑 → 续跑 → 看板）

> `orchestrate` 把你的一段**编排需求**交给 agent，让它**生成一段 flow 代码**（含多个 `cp.step`），再校验、执行这段 flow。
> 它**不是**"直接让 agent 干一件事"的入口——那是 `claude`/`cursor` 自己的活。
> 适合 orchestrate 的是「多步骤、需要流程设计、可中断续跑」的任务；手写 flow 适合「固定、可复用的流水线」。

## 0. 前置：环境就绪

第一次用，先确认环境（agent CLI 装了、配置有了）：

```bash
flowcast doctor          # 自检：哪些 CLI 可用、配置是否合法
flowcast init            # 未配置过？交互式扫描并生成 ~/.flowcast/{agents,providers}.json
```

至少要有一个 ready 的 agent（doctor 里打 ✓ 的）。`orchestrate` 生成 flow 时需要一个
agent 来产出代码，默认找 `claude-sonnet`——若你没有，用 `--agent <name>` 指定一个已配置的。

## 1. 何时用 orchestrate，何时手写 flow，何时直接让 agent 干

| 场景 | 选择 |
|------|------|
| 多步骤、需要流程设计、可中断续跑（"审计 src/ 并修复 lint 后跑测试"、"逐条实现 TODO 清单"） | **orchestrate** |
| 大目标，要并发拆成多个独立子任务 | **orchestrate --split** |
| 固定流水线，反复跑（每次发版、每次 PR） | **手写 flow**（放 `.flowcast/flows/`） |
| 需要 HITL 在固定节点卡住审批 | **手写 flow** |
| 一句话能搞定的单步任务（"加一行"、"改个变量名"） | **直接用 `claude`/`cursor`，别用 orchestrate** |

::: warning 别用 orchestrate 跑简单任务
`orchestrate` 会先调 agent 生成一段 flow 代码、再跑它。对一个"加一行 hello"这样的单步任务，
这层代码生成是纯浪费（多一次 LLM 调用 + 校验开销），而且简单任务根本用不上断点续跑/HITL/质量门。
判断标准：**如果这个任务不需要"多步骤"或"流程设计"，就直接让 agent 做，别 orchestrate。**
:::

## 2. 需求怎么写，生成更易成功

orchestrate 把你的**编排需求**交给 agent 生成 flow。需求写得越具体（范围 + 步骤意图 + 验收标准），生成的 flow 质量越高：

```bash
# ✗ 太模糊：agent 不知道要编排什么、边界和验收标准都不清
flowcast orchestrate "优化整个项目的错误处理" --repo .

# ✓ 明确的多步编排：有范围、有验收、天然需要拆步骤
flowcast orchestrate "把 src/ 下所有 console.log 清掉，确保 npm test 仍通过" --repo . --agent cursor-default

# ✓ 大目标用 --split 自动拆并发
flowcast orchestrate "给每个 src/*.ts 补上单元测试" --repo . --split --concurrency 3
```

**生成阶段也会烧 API**（要用 agent 产出 flow 代码）。想先验证结构不烧钱：

```bash
# 用一个真实编排需求跑 dry-run：生成走真 agent，但执行被 fake
FLOWCAST_DRY_RUN=1 flowcast orchestrate "审计 src/ 的 lint 问题并修复" --repo .
```

## 3. 生成之后怎么跑（完整闭环）

### 3.1 首次执行

```bash
flowcast orchestrate "<需求>" --repo . --agent <agent名>
```

输出会告诉你：
- `run=orch-<时间戳>` —— **记下这个 run-id，续跑要用**
- `flow: <repo>/.flowcast/runs/<run-id>/flow.mjs` —— 生成的 flow 文件位置
- 每步 `[run] p1.xxx` 正在执行 / `[skip]` 续跑跳过 / `[paused]` HITL 等待 / `[error]` 失败

### 3.2 中断后续跑（核心能力）

进程被 Ctrl-C / OOM / 超时杀掉后，**传同一个 run-id** 即可续跑，已完成步骤自动 `[skip]`：

```bash
flowcast orchestrate "<同样的需求>" --repo . --run-id orch-<上次的>
```

> 续跑锁定：run 目录已有 `flow.mjs` 就直接跑同一份，**不会重新生成**（保 resume 语义）。
> 想重新生成？删掉 `<repo>/.flowcast/runs/<run-id>/` 重来。

### 3.3 看运行状态

```bash
# 方法 1：看 state.json（当前跑到哪、暂停原因）
cat .flowcast/runs/<run-id>/state.json | jq '{status, currentStep, pauseReason}'

# 方法 2：看失败步骤的详细输出
cat .flowcast/runs/<run-id>/run.log.jsonl | jq 'select(.status == "error")'

# 方法 3：可视化看板（扫所有 run，生成单文件 HTML）
flowcast dashboard --repo . --open
```

### 3.4 生成失败 vs 执行失败

| 失败位置 | 报错关键词 | 怎么办 |
|---------|-----------|--------|
| 生成阶段 | `生成/校验失败（attempts=N）` | 看输出的 flow 文件，多半需求太模糊或 agent 不会写——改写需求重试 |
| 预检阶段 | `预检失败：无法解析 flowcast` | `cd <repo> && npm install flowcast`（目标仓要能 import 本包） |
| 执行阶段 | `[error] p1.xxx: ...` | 看 run.log.jsonl，通常是 agent CLI 报错（未登录/model 不可用）。`flowcast doctor` 复查 |

## 4. orchestrate 生成的 flow，和手写的是同构的

生成产物是标准 `.flowcast/runs/<id>/flow.mjs`，用的就是 `flowcast` 的公开 API
（`Checkpoint` / `runAgent` / `runGate` / `fanOut` 等）。所以：

- 你可以 `cp` 出来当手写 flow 复用：`cp .flowcast/runs/<id>/flow.mjs .flowcast/flows/my-flow.js`
- 之后用 `flowcast run .flowcast/flows/my-flow.js` 跑（不需要再 orchestrate）
- 完整 API 词汇表见 `orchestrator/FLOW_API.md`

## 5. 速查：orchestrate 全部参数

```bash
flowcast orchestrate "<需求>"                    # 单 flow 模式
  --repo <path>           # 目标仓（默认 cwd）
  --agent <name>          # 生成+执行用的 agent profile 名
  --run-id <id>           # 续跑指定同一 id
  --dry-run               # 执行被 fake，不烧 API
  --split                 # 大目标拆子任务并发执行
    --concurrency <n>     # --split 下的并发数（默认 2）
    --inplace             # --split 下不做 worktree 隔离
  --hitl terminal|wecom   # HITL 后端（默认 terminal）
  --timeout <ms>          # 执行超时
```
