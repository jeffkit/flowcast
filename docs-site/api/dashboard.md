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

指南见 [示例 · 可观测看板](/guide/examples)。
