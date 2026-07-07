# API · Agent 执行

驱动各种 coding agent CLI 的统一接口、跨 CLI 链式回退、并发工具与 HITL。

```js
import {
  runAgent, runAgentChain, setWorkdir, setAgentEventSink,
  claude, cursor, gemini, codex, aider, recursive, agy,
  spawnCapture, spawnCli, resolveRecursiveBin,
  recursiveProviderEnv, claudeProviderEnv, claudeApplyProvider,
  isProviderRetryable, emitAgentEvent,
  parallel, pipeline,
  waitForInput, notify, setHitlBackend, getHitlBackend,
} from 'flowcast'
```

## runAgent

```js
await runAgent(prompt, { cli = 'claude', cwd, ...opts })
```

统一驱动一个 CLI。`cli` 取值：`claude` / `cursor` / `gemini` / `codex` / `aider` / `recursive` / `agy`。返回值是字符串（agent 输出），并挂了 `_meta`（含 `cli`、`dryRun` 等）。

- `isDryRun()` 为真时**不真实调用**任何 CLI/API，返回假结果（`[dry-run] <cli> 未真实执行`）。
- 未知 `cli` 抛错。
- `cwd` 缺省用 `setWorkdir` 设的默认工作目录。

::: warning 取文本请用 `agentText(r)`，别信 `typeof`
返回值是 `String` 包装对象，`typeof r === 'object'`、`r instanceof String === true`。
模板字面量 / `String(r)` / `r + ''` / `JSON.stringify(r)` / 字符串方法（`includes`/`length`/...）都正常；
但写 `typeof r === 'string'` 会**静默 false**，走错分支。

推荐两种取法：

```js
import { agentText } from 'flowcast'

const text = agentText(result)        // 类型安全：string primitive / String 对象 / {text} 对象 都接
const cli  = result._meta?.cli        // 或直接读 _meta
```
:::

### setWorkdir(dir)

设置 `runAgent` 的默认工作目录。flow 启动时调一次即可。

### setAgentEventSink(fn)

注入 agent 事件回调（如 provider/CLI fallback 事件），看板据此观测。传非函数则清空。

### emitAgentEvent(evt)

手动向 agent 事件 sink 发送一个事件（测试 / 自定义 adapter 用）。需先调 `setAgentEventSink` 注入 sink。

## 各 CLI adapter

也可直接调具体 adapter（`runAgent` 内部就是分发到它们）：

| 函数 | 签名要点 |
|------|----------|
| `claude(prompt, { cwd, model, provider, timeout, extraArgs })` | BYO-LLM，可注入 provider（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`）+ provider 内部回退 |
| `cursor(prompt, { cwd, timeout, extraArgs })` | 锁定型，自管鉴权 |
| `gemini(prompt, { cwd, model, timeout, extraArgs })` | 锁定型 |
| `codex(prompt, { cwd, model, timeout, extraArgs })` | 锁定型 |
| `aider(prompt, { cwd, model, files, timeout, extraArgs })` | BYO-LLM（`OPENAI_API_BASE` / `_API_KEY`） |
| `recursive(goal, { cwd, maxSteps, ... })` | recursive 内核（Rust 二进制），走 `RECURSIVE_*` env |
| `agy(prompt, { cwd, model, timeout, extraArgs })` | 自带鉴权的编译型 agent CLI |

辅助函数：

- `spawnCapture(cmd, args, { cwd, timeout, env, onData })` — 受控子进程执行并捕获输出（质量门、mcp2cli 等内部用）。
- `spawnCli(cmd, args, opts)` — `spawnCapture` 的薄包装，失败时抛 `TimeoutError` / `SpawnError`。
- `resolveRecursiveBin(cwd)` — 定位 recursive 二进制。
- `recursiveProviderEnv({ type, apiBase, model, apiKey, maxSteps })` / `claudeProviderEnv(provider)` — 把 provider bundle 翻译成对应 env。
- `claudeApplyProvider(provider, env)` — 将 provider 配置注入 claude adapter 的 env 对象（BYO-LLM 用）。
- `isProviderRetryable(err)` — 判断错误是否为限额/超载/超时（可回退）。等价于 `isRetryable`，二者共享实现。

### 超时常量

各 CLI adapter 的默认超时（毫秒），可在 opts 中覆盖：

| 常量 | 默认值 |
|------|--------|
| `CLAUDE_DEFAULT_TIMEOUT` | 10 分钟 |
| `GEMINI_DEFAULT_TIMEOUT` | 10 分钟 |
| `CODEX_DEFAULT_TIMEOUT` | 10 分钟 |
| `AGY_DEFAULT_TIMEOUT` | 10 分钟 |
| `CURSOR_DEFAULT_TIMEOUT` | 10 分钟 |
| `AIDER_DEFAULT_TIMEOUT` | 10 分钟 |
| `RECURSIVE_DEFAULT_TIMEOUT` | 10 分钟 |

## runAgentChain

```js
await runAgentChain(prompt, chain, { runner, cooldown, cooldownBaseMs, cooldownMaxMs })
```

跨 CLI 的链式回退：`chain` 是一组 `runAgent` opts，按序尝试，某个因限额/超载/超时（`isRetryable`）失败就切下一个。

```js
await runAgentChain('实现 X', [
  { cli: 'claude', provider: { name: 'minimax', /* ... */ } },
  { cli: 'agy' },
  { cli: 'claude', provider: { name: 'deepseek', /* ... */ } },
])
```

可选传入共享 `cooldown`（`Map`）实现 **run 级自适应指数退避**：刚因限额挂掉的 agent 降级到链尾（按剩余冷却升序排），成功调用清除冷却。base/cap 可经 env 覆盖（`FLOWCAST_AGENT_COOLDOWN_BASE_MS` / `_MAX_MS`）。

与 claude adapter 内部的 provider 回退**正交**：这里能跨不同 CLI 回退。

## 并发工具

### parallel(thunks, opts?)

```js
parallel(
  thunks: Array<() => Promise>,
  opts?: {
    concurrency?: number,
    strict?: boolean,      // 默认 true
    failFast?: boolean,    // 默认 false
    onError?: ({ index, error }) => void,
  }
): Promise<Array>
```

并行跑多个 `() => Promise`。

**关键参数说明**：

- **`strict`（默认 `true`）**：等所有任务跑完后，若有失败则统一抛出 `ParallelError`（`err.failures` 含各失败任务的下标和原始 error）。注意：**不是 fail-fast**——第一个失败后其余任务仍会继续运行到结束。
- **`strict=false`**：失败任务在对应位置返回 `null`，不中断整体。适合「部分失败可接受」场景。注意无法区分「任务失败」和「任务本身返回 null」，如需区分请传 `onError`。
- **`failFast`（默认 `false`）**：第一个失败后停止尚未入队的任务（仅在设了 `concurrency` 时有效；已在跑的任务不会被强制中断）。
- **`onError`**：失败回调 `({index, error}) => void`，在保持 `null` 语义（`strict=false`）的同时追踪失败任务，是区分「失败」和「任务返回 null」的唯一可靠手段。`strict=true` 时同样有效（在汇总抛出前先触发回调）。
- **`concurrency`**：并发上限（缺省全部一起跑），结果按原下标顺序返回。

```js
// strict=true（默认）：失败汇总抛 ParallelError
try {
  const results = await parallel([task1, task2, task3])
} catch (err) {
  if (err instanceof ParallelError) {
    console.log(err.failures) // [{index, error}, ...]
  }
}

// strict=false + onError：部分失败可接受
const results = await parallel([task1, task2, task3], {
  strict: false,
  onError: ({ index, error }) => console.warn(`任务 ${index} 失败：${error.message}`),
})
// results[失败位置] = null

// 有限并发 + failFast：限制同时跑 2 个，第一个失败后停止剩余入队
const results = await parallel(tasks, { concurrency: 2, failFast: true })
```

### pipeline(items, ...stages, opts?)

```js
pipeline(
  items: Array,
  ...stages: Array<async (prev, item, index) => next>,
  opts?: {
    concurrency?: number,        // 默认 CPU 核数
    onError?: ({ index, item, error }) => void,
  }
): Promise<Array>
```

把 `items` 依次流经多个 stage，每个 item 独立穿过所有 stage，stage 间无 barrier（快的 item 先跑完）。

- **stage 签名**：`async (prev, item, index) => next`，`prev` 是上一个 stage 的输出（第一个 stage 收到原始 item）。
- **容错**：某 item 在任一 stage 抛错，该 item 结果置 `null`（不中断其他 item）。
- **`onError`**：错误回调 `({index, item, error}) => void`，是区分「失败」和「item 本身返回 null」的唯一手段。
- **`concurrency`**：同时处理的 item 数（默认 CPU 核数）。

```js
const results = await pipeline(
  ['task-a', 'task-b', 'task-c'],
  async (prev, item) => await runAgent(`分析 ${item}`, { cli: 'claude' }),
  async (prev, item) => await runAgent(`基于以下分析实现 ${item}:\n${prev}`, { cli: 'claude' }),
  { concurrency: 2, onError: ({ index, error }) => console.warn(`item[${index}] 失败`) }
)
```

与 `parallel` 的区别：`parallel` 是「一组 thunk 同时跑」的单层 barrier；`pipeline` 是「多 item 各自串行穿过多 stage」的无 barrier 流水线。

## HITL

```js
setHitlBackend('terminal' | 'wecom' | customObject, config?)
const text = await waitForInput(prompt)   // 阻塞等输入
await notify(message)                       // 单向通知
getHitlBackend()                           // 当前后端（调试用）
```

::: warning 默认值变更（v0.2.0）
`setHitlBackend` 默认值从 `terminalBackend` 改为 `null`。未调 `setHitlBackend` 时 `waitForInput` / `notify` 抛清晰错误（不再静默用 terminal 在非 TTY 卡死）。需要 terminal 输入时请显式 `setHitlBackend('terminal')`。
:::

详见 [HITL 指南](/guide/hitl)。
