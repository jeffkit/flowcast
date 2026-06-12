# API · Agent 执行

驱动各种 coding agent CLI 的统一接口、跨 CLI 链式回退、并发工具与 HITL。

```js
import {
  runAgent, runAgentChain, setWorkdir, setAgentEventSink,
  claude, cursor, gemini, codex, aider, recursive, agy,
  spawnCapture, resolveRecursiveBin, recursiveProviderEnv, claudeProviderEnv, isProviderRetryable,
  parallel, pipeline,
  waitForInput, notify, setHitlBackend, getHitlBackend,
} from '@force-lab/flowx'
```

## runAgent

```js
await runAgent(prompt, { cli = 'claude', cwd, ...opts })
```

统一驱动一个 CLI。`cli` 取值：`claude` / `cursor` / `gemini` / `codex` / `aider` / `recursive` / `agy`。返回值是字符串（agent 输出），并挂了 `_meta`（含 `cli`、`dryRun` 等）。

- `isDryRun()` 为真时**不真实调用**任何 CLI/API，返回假结果（`[dry-run] <cli> 未真实执行`）。
- 未知 `cli` 抛错。
- `cwd` 缺省用 `setWorkdir` 设的默认工作目录。

### setWorkdir(dir)

设置 `runAgent` 的默认工作目录。flow 启动时调一次即可。

### setAgentEventSink(fn)

注入 agent 事件回调（如 provider/CLI fallback 事件），看板据此观测。传非函数则清空。

## 各 CLI adapter

也可直接调具体 adapter（`runAgent` 内部就是分发到它们）：

| 函数 | 签名要点 |
|------|----------|
| `claude(prompt, { cwd, model, provider, timeout, extraArgs })` | BYO-LLM，可注入 provider（`ANTHROPIC_BASE_URL` / `_API_KEY`）+ provider 内部回退 |
| `cursor(prompt, { cwd, timeout, extraArgs })` | 锁定型，自管鉴权 |
| `gemini(prompt, { cwd, model, timeout, extraArgs })` | 锁定型 |
| `codex(prompt, { cwd, model, timeout, extraArgs })` | 锁定型 |
| `aider(prompt, { cwd, model, files, timeout, extraArgs })` | BYO-LLM（`OPENAI_API_BASE` / `_API_KEY`） |
| `recursive(goal, { cwd, maxSteps, ... })` | recursive 内核（Rust 二进制），走 `RECURSIVE_*` env |
| `agy(prompt, { cwd, model, timeout, extraArgs })` | 自带鉴权的编译型 agent CLI |

辅助：

- `spawnCapture(cmd, args, { cwd, timeout, env, onData })` — 受控子进程执行并捕获输出（质量门、mcp2cli 等内部用）。
- `resolveRecursiveBin(cwd)` — 定位 recursive 二进制。
- `recursiveProviderEnv({ type, apiBase, model, apiKey, maxSteps })` / `claudeProviderEnv(provider)` — 把 provider bundle 翻译成对应 env。
- `isProviderRetryable(err)` — 判断错误是否为限额/超载/超时（可回退）。

## runAgentChain

```js
await runAgentChain(prompt, chain, { runner, cooldown, cooldownBaseMs, cooldownMaxMs })
```

跨 CLI 的链式回退：`chain` 是一组 `runAgent` opts，按序尝试，某个因限额/超载/超时（`isProviderRetryable`）失败就切下一个。

```js
await runAgentChain('实现 X', [
  { cli: 'claude', provider: { name: 'minimax', /* ... */ } },
  { cli: 'agy' },
  { cli: 'claude', provider: { name: 'deepseek', /* ... */ } },
])
```

可选传入共享 `cooldown`（`Map`）实现 **run 级自适应指数退避**：刚因限额挂掉的 agent 降级到链尾（按剩余冷却升序排），成功调用清除冷却。base/cap 可经 env 覆盖（`FLOWX_AGENT_COOLDOWN_BASE_MS` / `_MAX_MS`）。

与 claude adapter 内部的 provider 回退**正交**：这里能跨不同 CLI 回退。

## 并发工具

### parallel(thunks, { concurrency? })

并行跑多个 `() => Promise`。某个失败返回 `null`（不中断整体）。`concurrency` 限并发（缺省全部一起跑），结果按原下标顺序返回。

### pipeline(items, ...stages)

把 `items` 依次流经多个 stage，每个 stage 是 `async (item, i) => result`。

## HITL

```js
setHitlBackend('terminal' | 'wecom' | customObject, config?)
const text = await waitForInput(prompt)   // 阻塞等输入
await notify(message)                       // 单向通知
getHitlBackend()                           // 当前后端（调试用）
```

详见 [HITL 指南](/guide/hitl)。
