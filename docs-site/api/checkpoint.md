# API · Checkpoint

断点续跑的步骤记录器。把一条 flow 拆成可记录、可跳过的步骤，状态落盘在 `.flowx/runs/<run-id>/`。

```js
import { Checkpoint } from '@force-lab/flowx'
```

## 构造

```js
new Checkpoint(runId, stateDir = '.flowx/runs')
```

- `runId` — run 标识；续跑必须传同一个。
- `stateDir` — 状态根目录（默认 `.flowx/runs`）。

构造时会创建 `<stateDir>/<runId>/`，已有 `state.json` 则加载（实现续跑）。

## 方法

### `await cp.step(key, fn, { meta? })`

把一个步骤纳入 checkpoint。

- 若 `key` 已完成 → 打印 `[skip]`，返回缓存结果。
- 否则 → 打印 `[run]`，执行 `fn()`，存档返回值并落盘。
- `fn` 抛错 → 记录 error 到 `run.log.jsonl` 后重新抛出（**不**标记完成）。

`key` 在同一 run 内必须唯一。`meta` 会并入步骤记录（如 `{ cli: 'claude' }`）。

### `cp.pause(reason, context = {})`

暂停 flow 并干净退出（`process.exit(0)`）。状态置 `paused`，记录 `pauseReason` / `pauseContext`。续跑时用 `getPauseContext()` 取回。

### `cp.done(summary = {})`

标记整个 flow 完成，置 `completed`，生成 `report.md`（含总耗时、步骤表）。

### `cp.has(key) → boolean`

是否已记录过某 key。用于 `parallel` / `fanOut` 时过滤已完成的子任务。

### `cp.record(key, result, meta = {}) → result`

**并发安全**地记录一个已算好的结果（非 `fn`）。整段同步执行、无 `await`，单线程下并发回调也不会交错，适合在 `onResult` 回调里回写子任务完成状态。

### `cp.event(type, data = {})`

追加一条"非步骤"的结构化事件到 `run.log.jsonl`（**不**进 `state.json`，避免膨胀）。看板据此读取 provider fallback / 质量门红灯等信号。写盘异常会被吞掉（观测不影响主流程）。

### `cp.getPauseContext() → object`

取回 `pause` 时存的 `context`。

### `cp.status → string`

当前状态：`running` / `paused` / `completed`。

## 落盘产物

```
.flowx/runs/<run-id>/
├── state.json       # { runId, status, completed, steps, pauseReason?, summary? }
├── run.log.jsonl    # 每行一条：步骤记录 / 错误 / event 事件
└── report.md        # done() 后生成的可读摘要
```

## 示例

```js
const cp = new Checkpoint(runId)

const plan = await cp.step('plan', () => runAgent('做计划', { cli: 'claude' }))

if (needsReview) cp.pause('等人工确认', { plan })

await cp.step('build', () => build(plan), { meta: { cli: 'claude' } })

cp.done({ steps: 2 })
```

指南见 [断点续跑](/guide/checkpoint)。
