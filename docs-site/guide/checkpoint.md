# 断点续跑（Checkpoint）

`Checkpoint` 是 flowcast 最核心的原语：把一条 flow 拆成若干**可记录的步骤**，中断后用同一个 `run-id` 续跑，已完成的步骤**零重复执行**。

## 工作原理

`Checkpoint` 在 `.flowcast/runs/<run-id>/` 下维护三个文件：

```
state.json       → status、各步骤完成情况（completed）、暂停原因
run.log.jsonl    → 每步耗时、输入输出、错误（每行一条，完整审计）
report.md        → done 后生成的可读摘要
```

每个 `cp.step(key, fn)`：

1. 若 `key` 已在 `completed` 中 → 打印 `[skip]`，直接返回缓存结果。
2. 否则 → 打印 `[run]`，执行 `fn()`，把返回值存进 `completed[key]` 并落盘。
3. `fn` 抛错 → 记录 error 到日志后**重新抛出**（不会标记完成）。

因此续跑时，从崩溃点之前的所有步骤都会被跳过，flow 从断点继续。

## 基本用法

```js
import { Checkpoint } from 'flowcast'

const cp = new Checkpoint(runId)   // runId 缺省自动生成；续跑必须传同一个

const plan = await cp.step('plan', async () => {
  return await doPlanning()
})

const result = await cp.step('build', async () => {
  return await build(plan)
})

cp.done({ artifacts: result.length })   // 标记完成，生成 report.md
```

::: warning step key 必须唯一
同一个 run 内 `key` 重复会被当作"已完成"而跳过。给每个步骤起一个稳定、唯一的名字（如 `analyze`、`gate.lint`、`task.0.impl`）。
:::

## HITL 暂停与续跑

`cp.pause(reason, context)` 把 flow 干净地暂停并 `exit(0)`，下次续跑时可以从 `cp.getPauseContext()` 取回上下文：

```js
if (needsHumanReview) {
  cp.pause('等待人工确认 PR 描述', { prNumber: 42 })
  // 进程在此干净退出
}

// 续跑时
const ctx = cp.getPauseContext()   // { prNumber: 42 }
```

配合 HITL 后端可以做到"阻塞等人工输入"，详见 [HITL 人工介入](/guide/hitl)。

## 并发安全记录

在 `parallel` / `fanOut` 里，各子任务并发完成，需要并发安全地回写状态。用 `cp.has` 过滤已完成、`cp.record` 回写结果（整段同步执行、无 `await`，单线程下不会交错）：

```js
for (const task of tasks) {
  if (cp.has(task.name)) continue          // 跳过已完成的子任务
}

await fanOut(pending, {
  concurrency: 3,
  onResult: ({ task, result }) => {
    cp.record(task.name, { ok: result.ok })   // 并发安全回写
  },
})
```

## 观测事件

`cp.event(type, data)` 追加一条"非步骤"的结构化事件到 `run.log.jsonl`（不进 `state.json`，避免膨胀）。看板据此读取 provider fallback、质量门红灯等可观测信号：

```js
cp.event('fallback', { from: 'claude/minimax', to: 'agy', reason: 'timeout' })
```

观测用途绝不影响主流程——写盘异常会被吞掉。

## API 速览

| 方法 | 作用 |
|------|------|
| `new Checkpoint(runId, stateDir?)` | 初始化（默认 `stateDir = '.flowcast/runs'`） |
| `await cp.step(key, fn, { meta? })` | 纳入 checkpoint 的步骤；有缓存就跳过 |
| `cp.pause(reason, context?)` | 暂停并干净退出（`exit 0`） |
| `cp.done(summary?)` | 标记完成，生成 `report.md` |
| `cp.has(key)` | 是否已记录过某 key |
| `cp.record(key, result, meta?)` | 并发安全地记录已算好的结果 |
| `cp.event(type, data?)` | 追加结构化观测事件到 jsonl |
| `cp.getPauseContext()` | 取回 pause 时存的上下文 |
| `cp.status` | 当前状态（`running` / `paused` / `completed`） |

完整签名见 [API · Checkpoint](/api/checkpoint)。
