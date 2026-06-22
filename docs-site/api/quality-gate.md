# API · 质量门 / 自改沙箱

```js
import { runGate, runGates, loadGates, mergeGates, withSelfModGuard, captureBaseline, writeFailureContext, readAndConsumeFailureContext } from 'flowcast'
```

## runGate(gate, deps?)

执行单个质量门。

```js
await runGate({
  name: 'test',          // 门名（test/clippy/fmt/e2e…）
  cmd: 'npm test',       // 检查命令（string 或 string[]，走 sh -c）
  cwd: process.cwd(),    // 工作目录
  onFail: 'rollback',    // 'rollback' | 'resume-fix' | 'autofix'（默认 rollback）
  autofixCmd: undefined, // onFail=autofix 时的修复命令
  resumeFix: undefined,  // onFail=resume-fix 时的修复回调（覆盖 deps.resumeFix）
  timeout: undefined,    // 单命令超时 ms
  onEvent: undefined,    // 观测回调（覆盖 deps.onEvent）
}, {
  resumeFix: async (failureOutput, gate) => boolean,  // 返回是否已应用修复
  onEvent: (e) => void,
})
```

返回：`{ name, passed, attempts, output, autofixed?, resumeFixed?, dryRun? }`。

**onFail 策略**：

| 策略 | 行为 |
|------|------|
| `rollback`（默认） | 红灯抛错（`err.gate` / `err.output` / `err.exitCode`），交给 `withSelfModGuard` 回滚 |
| `resume-fix` | 把失败输出喂回 `resumeFix`，应用修复后重测一次；仍红则抛错 |
| `autofix` | 跑 `autofixCmd` 后重测验证；通过返回 pass，仍失败抛 `GateError` |

`isDryRun()` 为真时**不 spawn、直接判过**（返回 `{ passed: true, dryRun: true }`）。

## runGates(gates, deps?)

顺序跑多个门。任意门红灯（rollback / resume-fix 仍失败）即抛错。返回结果数组。

```js
await runGates([
  { name: 'fmt',    cmd: 'cargo fmt --check', onFail: 'autofix', autofixCmd: 'cargo fmt' },
  { name: 'clippy', cmd: 'cargo clippy -- -D warnings' },
  { name: 'test',   cmd: 'cargo test' },
], { resumeFix, onEvent })
```

### 并发执行（deps.parallel）

`runGates` 默认串行执行。设 `deps.parallel = true` 时并发跑所有门（使用 `parallel({ strict: true })`）：

```js
await runGates(gates, { resumeFix, parallel: true })
```

注意：`onFail: 'resume-fix'` 策略建议继续串行（并发时上下文可能冲突）。

## captureBaseline(repo, { requireClean? })

捕获 git baseline，返回 baseline commit sha。

- 要求存在 HEAD commit（否则抛错）。
- `requireClean`（默认 `true`）时要求工作树干净（否则抛错并列出脏文件）。

## withSelfModGuard(fn, opts?)

在自改安全沙箱中执行 `fn`，失败硬回滚。

```js
await withSelfModGuard(async ({ repo, baseline }) => {
  // ...改代码 + 质量门...
  return { verdict: 'committed' }   // 或 'rolled-back' / 'skip-commit' / 'panic-preserved'
}, {
  repo: process.cwd(),
  requireClean: true,    // 跑前要求工作树干净
  baseline: undefined,   // 显式 baseline（默认取当前 HEAD）
  clean: true,           // 回滚时是否 git clean -fd
})
```

返回 `{ baseline, ...fnResult }`。

**verdict 语义**：

| verdict | 行为 |
|---------|------|
| （抛错） | 硬回滚到 baseline（reset --hard + clean） |
| `rolled-back` | 硬回滚 |
| `committed` | 不回滚（调用方已自行 commit） |
| `skip-commit` | 不回滚（故意留脏） |
| `panic-preserved` | 不回滚（保留现场给人诊断） |

指南见 [质量门与自改沙箱](/guide/quality-gate)。

## loadGates({ repo, dirs? })

从项目仓 `.flowcast/gates.json`（以及 `~/.flowcast/gates.json` 机器级）加载声明式质量门配置，返回门数组。

```js
import { loadGates, mergeGates } from 'flowcast'

// .flowcast/gates.json 示例
// {
//   "test":   { "cmd": "npm test",          "onFail": "resume-fix" },
//   "lint":   { "cmd": "npm run lint",       "onFail": "autofix", "autofixCmd": "npm run lint:fix" },
//   "build":  { "cmd": "npm run build" }
// }

const projectGates = await loadGates({ repo: process.cwd() })
// → [{ name: 'test', cmd: 'npm test', onFail: 'resume-fix' }, ...]
```

每个门条目必须是对象且包含 `cmd` 字段，否则抛 `ConfigError`。

## mergeGates(builtin, project)

合并「内置默认门」与「项目自定义门」。同名时项目级覆盖内置，内置门保持原序在前，项目新增门追加在后。

```js
const builtinGates = [
  { name: 'test',   cmd: 'cargo test' },
  { name: 'clippy', cmd: 'cargo clippy -- -D warnings' },
  { name: 'fmt',    cmd: 'cargo fmt --check', onFail: 'autofix', autofixCmd: 'cargo fmt' },
]

const projectGates = await loadGates({ repo })
const gates = mergeGates(builtinGates, projectGates)
// 项目若声明了 test 门，则覆盖内置 test；项目新增的门追加在 fmt 之后

await runGates(gates, { resumeFix })
```

典型模式：flow 内置语言默认门（`cargo test / clippy / fmt`），业务项目通过 `.flowcast/gates.json` 声明额外门或覆盖默认参数，两者通过 `mergeGates` 合并后统一跑。

## 失败上下文

把失败信息落盘，下次注入 prompt（写入即消费）：

```js
writeFailureContext(dir, tag, { reason, tailLog, provider, model })
const ctx = readAndConsumeFailureContext(dir, tag)   // 读出后删除
```
