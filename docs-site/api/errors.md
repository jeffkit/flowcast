# API · 错误类型

flowcast 使用统一的错误层次体系，所有错误都从 `flowcast` 主入口导出。

```js
import {
  FlowcastError, TimeoutError, SpawnError, GateError, SchemaError,
  ConfigError, PathError, LockError, GitError, ParallelError,
  VerifyError, GuardError, PauseSignal, isRetryable,
} from 'flowcast'
```

## 设计原则

- `FlowcastError` 是所有 flowcast 抛出错误的**基类**，可用 `instanceof FlowcastError` 统一捕获。
- 各子类通过 `code` 字段区分错误语义，**不应解析 `message` 字符串**做逻辑判断。
- `isRetryable(err)` 是**唯一**判定「是否可回退到下一 provider/CLI」的入口。
- `PauseSignal` 是流控信号（继承 `Error` 而非 `FlowcastError`），不是错误。

## `FlowcastError`（基类）

```js
class FlowcastError extends Error {
  code: string   // 机器可读的错误码
}
```

所有 flowcast 错误的基类。`code` 字段是机器可读的错误码，用于程序化分支：

```js
try {
  await runGate(gate)
} catch (err) {
  if (err instanceof GateError) {
    console.log(err.gate)      // 门名
    console.log(err.exitCode)  // 退出码
  } else if (err instanceof FlowcastError) {
    console.log(err.code)      // 通用处理
  }
}
```

## 错误子类一览

| 类名 | `code` | 触发场景 | 关键字段 |
|------|--------|----------|----------|
| `TimeoutError` | `TIMEOUT` | spawn 超时 | `timedOut = true` |
| `SpawnError` | `SPAWN_ERROR` | 进程启动失败或非零退出 | `spawnError`（启动失败时非 null），`exitCode` |
| `GateError` | `GATE_FAIL` | quality gate 失败 | `gate`（门名），`exitCode`，`output` |
| `SchemaError` | `SCHEMA_ERROR` | JSON Schema 校验失败 | `schemaError`（错误描述） |
| `ConfigError` | `CONFIG_ERROR` | provider/executor 配置错误 | `configError = true` |
| `PathError` | `PATH_ERROR` | 路径安全校验失败（`assertSafeIdent`） | — |
| `GuardError` | `GUARD_FAIL` 或 `ROLLBACK_FAIL` | `withSelfModGuard` 前置检查或回滚失败 | — |
| `GitError` | `GIT_FAIL` | git 命令执行失败 | `stderr`（原始错误输出） |
| `VerifyError` | `VERIFY_FAIL` | `verifyAdversarial` 所有 voter 均失败 | `voterErrors: {lens, error}[]` |
| `ParallelError` | `PARALLEL_FAIL` | `parallel(strict=true)` 有任务失败 | `failures: {index, error}[]` |
| `LockError` | `LOCK_BUSY` / `LOCK_RETRY_EXHAUSTED` / `LOCK_OWNER_PENDING` | 续跑锁相关 | — |

## `TimeoutError`

```js
class TimeoutError extends FlowcastError {
  timedOut: true
}
```

spawn 调用超时时抛出（`spawnCli` / `spawnCapture` 均会触发）。`isRetryable(err)` 对 `timedOut=true` 的错误返回 `true`。

## `SpawnError`

```js
class SpawnError extends FlowcastError {
  spawnError: string | null   // null = 进程启动成功但以非零码退出
  exitCode?: number
}
```

覆盖两种场景：
- `spawnError` 非 null：进程无法启动（`ENOENT` / `EACCES` 等系统错误）。
- `spawnError` 为 null + `exitCode`：进程启动成功但以非零码退出。

## `GateError`

```js
class GateError extends FlowcastError {
  gate: string     // 质量门名称
  exitCode: number
  output: string   // 检查命令的原始输出
}
```

`runGate` / `runGates` 在门红灯且 `onFail=rollback` 时抛出。消息格式：

```
quality gate 'test': failed (exit 1)
quality gate 'test': still failing after autofix (exit 1)
```

## `SchemaError`

```js
class SchemaError extends FlowcastError {
  schemaError: string   // 具体校验错误描述
}
```

`validateSchema` 校验失败，或 `runStructured` 多次重试后仍无法获得合法结构化输出时抛出。

## `ConfigError`

```js
class ConfigError extends FlowcastError {
  configError: true
}
```

provider / executor 配置错误：`onFail=autofix` 缺 `autofixCmd`、`onFail=resume-fix` 缺 `resumeFix`、`resolveAgent` 找不到 agent 等。

## `PathError`

```js
class PathError extends FlowcastError {}
```

`assertSafeIdent(name)` 发现标识符含非法字符时抛出。字符规则：以字母数字开头/结尾，中间允许字母数字、`.`、`_`、`-`。

## `GuardError`

```js
class GuardError extends FlowcastError {}
// code = 'GUARD_FAIL'   → withSelfModGuard 前置检查失败
// code = 'ROLLBACK_FAIL' → 回滚本身失败（原始错误通过 Error.cause 保留）
```

`withSelfModGuard` 的安全沙箱失败时抛出。回滚失败时，`err.cause` 含原始业务错误。

## `GitError`

```js
class GitError extends FlowcastError {
  stderr?: string   // git 命令的原始 stderr 输出
}
```

`gitCommitAll` / `gitWorktreeAdd` 等 git 原语执行失败时抛出。

## `VerifyError`

```js
class VerifyError extends FlowcastError {
  voterErrors: Array<{ lens: string, error: string }>
}
```

`verifyAdversarial` 中**所有** voter 均失败（网络/限额等）、无法完成验证时抛出。若仅部分 voter 失败，不抛错，失败信息记入返回值的 `voterErrors` 字段。

## `ParallelError`

```js
class ParallelError extends FlowcastError {
  failures: Array<{ index: number, error: Error }>
}
```

`parallel(thunks, { strict: true })` 有任务失败时，**等所有任务跑完后**汇总抛出。`failures` 含每个失败任务的下标和原始错误。

```js
try {
  await parallel([task1, task2, task3])
} catch (err) {
  if (err instanceof ParallelError) {
    for (const { index, error } of err.failures) {
      console.log(`任务 ${index} 失败：${error.message}`)
    }
  }
}
```

## `LockError`

```js
class LockError extends FlowcastError {}
// code 取值：
//   'LOCK_BUSY'              → 锁被活跃进程持有
//   'LOCK_RETRY_EXHAUSTED'   → 重试次数超过上限（默认 20 次）
//   'LOCK_OWNER_PENDING'     → owner.json 尚未写入（中间态）
```

`orchestrate` 续跑锁相关错误。正常情况下用户感知不到，仅在并发 orchestrate 冲突或锁文件损坏时出现。

## `PauseSignal`

```js
class PauseSignal extends Error {
  pauseReason: string
  pauseContext: object
}
```

`cp.pause()` 抛出此信号，用于让 flow 入口点（而非库内部）决定是否 `process.exit`，`finally` 块和测试都能正常拦截。

::: warning 注意
`PauseSignal` 继承 `Error` 而非 `FlowcastError`——它是流控信号，**不是错误**。不要用 `instanceof FlowcastError` 捕获它。
:::

```js
import { PauseSignal } from 'flowcast'

try {
  await cp.step('task', () => longWork())
} catch (err) {
  if (err instanceof PauseSignal) {
    console.log('flow 已暂停，原因：', err.pauseReason)
    process.exit(0)   // 或保存状态、通知用户
  }
  throw err
}
```

## `isRetryable(err)`

```js
isRetryable(err: any): boolean
```

判断错误是否为 provider 限额/超载/超时，可尝试切换到下一个 provider/CLI。是**唯一**的 provider 回退判定入口。

判定条件（满足任一即为 true）：

1. `err.timedOut === true`（`TimeoutError`）
2. `err.apiStatus` 为 `429` 或 `529`（速率限制 / 过载）
3. message 匹配关键词（`rate limit` / `session limit` / `too many requests` / `quota` / `overloaded` / `429` / `529`）——作为无结构化字段时的兜底

```js
import { isRetryable } from 'flowcast'

try {
  result = await runAgent(prompt, { cli: 'claude' })
} catch (err) {
  if (isRetryable(err)) {
    // 可切换到备用 provider 或 CLI 重试
    result = await runAgent(prompt, { cli: 'agy' })
  } else {
    throw err
  }
}
```

`runAgentChain` 内部就是用 `isRetryable` 决定是否切换链中下一个条目。
