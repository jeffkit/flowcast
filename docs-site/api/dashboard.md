# API · Dashboard

只读可观测看板：扫描 `.flowcast/runs` 与 worktree，重建父子运行树、推断僵尸进程，生成单文件 HTML 快照。

```js
import { collectRuns, renderHtml, generateDashboard } from 'flowcast'
```

## CLI

```bash
flowcast dashboard --repo . [--open]
# → .flowcast/dashboard.html
```

## generateDashboard(opts)

采集 → 渲染 → 落盘，一步到位。

```js
const { out, model } = generateDashboard({
  repo: process.cwd(),     // 仓根目录
  out: undefined,          // 输出路径（默认 <repo>/.flowcast/dashboard.html）
  staleMs: undefined,      // 僵尸阈值（默认 10 分钟无活动且仍 running → 僵尸）
  now: undefined,          // 注入当前时间（测试用）
})
```

## collectRuns(repo, { staleMs?, now? })

扫描所有 run，重建模型：

- 跨主仓 + worktree 采集每条 run 的 `state.json` / `run.log.jsonl`。
- 重建父子运行树（orchestrate / fanOut 的子 run 挂到父下）。
- 僵尸推断：超过 `staleMs`（默认 10 分钟）无活动且仍 `running` 的 run 标为僵尸。
- 从 jsonl 的 `event` 行读出 provider fallback、质量门红灯等可观测信号。

返回结构化模型对象（供 `renderHtml` 渲染或自定义消费）。

## renderHtml(model)

把模型渲染成**单文件 HTML**（自包含，无外部依赖，可直接打开或托管）。

## 埋点来源

看板的数据来自这些埋点，无需额外配置：

- `Checkpoint` 的 `state.json` / `run.log.jsonl`（步骤、状态、耗时）。
- `cp.event(type, data)` 写入的结构化事件。
- `setAgentEventSink(fn)` 捕获的 agent/CLI fallback 事件。
- 质量门的 `onEvent` 回调（pass/fail 红灯）。

## EVENT_TYPES 事件 schema 字典

`run.log.jsonl` 里的事件是开放 schema（`cp.event(type, data)` 任意 type + object），但只有中央登记的事件类型会被 `summarizeEvents` 识别与统计。新增 event type 时务必在此登记，否则看板静默丢。

```js
import { EVENT_TYPES } from 'flowcast/dashboard/collect.js'
// 查 fallback 事件 schema
console.log(EVENT_TYPES.fallback.schema)
// { scope: "'provider'|'cli'", cli: 'string', from: 'string', to: 'string', reason: 'string' }
console.log(EVENT_TYPES.fallback.writer)  // 'agent.js（emitAgentEvent，触发于 provider/CLI 限额回退）'
console.log(EVENT_TYPES.fallback.reader)  // 'dashboard/collect.js summarizeEvents（按 scope 分桶）'
```

| Event type | 触发场景 | 关键字段 | 看板统计 |
|------------|---------|---------|---------|
| `fallback` | provider/CLI 限额回退 | `scope: 'provider'\|'cli'`, `cli`, `from`, `to`, `reason` | `signals.fallback`、`signals.fallbackByScope` |
| `gate` | 质量门结果 | `name`, `status: 'pass'\|'fail'`, `exitCode` | `signals.gatePass`、`signals.gateFail` |
| `group` | fanOut 任务组完成 | `name`, `status: 'done'\|'failed'`, `reason?` | `signals.group.done`、`signals.group.failed` |
| `loop` | loop 原语各阶段 | `phase: 'start'\|'iterate'\|'turn-done'\|'budget'\|'failed'`, `turn`, `fromTurn?`, `maxTurns?`, `reason?`, `done?`, `error?` | `signals.loop.turns`、`signals.loop.budgetExhausted`、`signals.loop.failed` |

指南见 [示例 · 可观测看板](/guide/examples)。
