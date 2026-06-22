# API · Checkpoint

断点续跑的步骤记录器。把一条 flow 拆成可记录、可跳过的步骤，状态落盘在 `.flowcast/runs/<run-id>/`。

```js
import { Checkpoint } from 'flowcast'
```

## 构造

```js
new Checkpoint(runId, stateDir = '.flowcast/runs')
```

- `runId` — run 标识；续跑必须传同一个。
- `stateDir` — 状态根目录（默认 `.flowcast/runs`）。

构造时会创建 `<stateDir>/<runId>/`，已有 `state.json` 则加载（实现续跑）。

**第三参数 `{ onStep }`（可选）**：step 生命周期横切钩子。

```js
const cp = new Checkpoint(runId, stateDir, {
  onStep: ({ event, key, durationMs, result, error }) => {
    // event: 'start' | 'done' | 'skip' | 'error'
    console.log(`[${event}] ${key}`, durationMs ? `${durationMs}ms` : '')
  },
})
```

`onStep` 抛出的异常会被吞掉，绝不影响主流程。适用于自定义埋点、调试日志等场景。

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

事件类型与字段约定见 [`EVENT_TYPES`](/api/dashboard#event_types) 中央字典——新增 event type 时务必在那里登记。

### `cp.getStepResult(key) → result | undefined`

读取已完成步骤的完整结果（透明处理 sidecar 大结果文件）。`key` 不在 `completed` 中返回 `undefined`。用于 loop 原语续跑时读上一轮产物。

### `cp.getLoopState() → { verdict?, status?, turns?, reason? }`

读 loop 协作状态（`verdict: 'done'|'continue'` 等）。`loop` 原语协作的窄接口——下游不要直接读 `cp.state.loopXxx`。

### `cp.setLoopState({ verdict?, status?, turns?, reason? })`

部分更新 loop 协作字段（未传不动）。**自动 flush 落盘**——外部 API 调用即意图已定。

### `cp.countCompletedTurns() → number`

::: warning 已废弃
`countCompletedTurns()` 将 `turn-N` 命名约定硬编码在 Checkpoint 里（loop 概念泄漏）。
请使用通用替代方法 `cp.countCompletedKeysWithPrefix('turn-')`。
:::

统计已完成 `turn-N` 形式的步骤数（`^turn-\d+$`）。`loop` 原语续跑推断起始 turn 用。

### `cp.countCompletedKeysWithPrefix(prefix) → number`

统计 step key 以指定前缀开头且已完成的步骤数量。通用版本，替代已废弃的 `countCompletedTurns()`。

```js
// 统计已完成的 turn-N 步骤数（等价于旧 countCompletedTurns()）
const turns = cp.countCompletedKeysWithPrefix('turn-')

// 统计其他自定义前缀的步骤
const phases = cp.countCompletedKeysWithPrefix('phase-')
```

### `cp.setExpectMaxMs(ms)`

声明本 run 期望最长跑多久。dashboard 自适应僵尸阈值用——`ms > 0` 时写 `state.expectMaxMs`，`staleMs = max(staleMs, expectMaxMs)`。

### `cp.getPauseContext() → object`

取回 `pause` 时存的 `context`。

### `cp.flush()`

强制同步落盘 `state.json`（正常使用无需手动调用，仅供极少数需要立即持久化的场景）。

### `cp.flushLog()`

返回挂起的日志写入 Promise 队列（用于测试或关键路径等待日志完全落盘）：

```js
await cp.flushLog()  // 等待所有异步日志写入完成
```

### `cp.status → string`

当前状态：`running` / `paused` / `completed`。

## 落盘产物

```
.flowcast/runs/<run-id>/
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
