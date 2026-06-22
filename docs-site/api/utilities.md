# API · 实用工具

跨模块复用的纯函数、辅助原语与启动时兜底。

## `assertSafeIdent(name, field?)`

```js
assertSafeIdent(name: string, field?: string): string
```

任务/资源标识符白名单校验。返回 `name`，不合法时抛 `PathError`。

```js
import { assertSafeIdent } from 'flowcast'

assertSafeIdent('task-a')          // OK，返回 'task-a'
assertSafeIdent('../escape')       // throw PathError: contains unsafe characters
assertSafeIdent('.hidden')         // throw PathError: 必须以字母数字开头
```

**字符规则**：以字母数字开头/结尾，中间允许字母数字、`.`、`_`、`-`。

**用途**：`subflow` 的 `task.name`、`writeFailureContext` / `readAndConsumeFailureContext` 的 `tag`、`runFlow` 的 `runId` 都走此校验。`path.join` 不阻止 `..` 解析，必须用白名单字符拦在源头。

**错误类型**：抛 `PathError`（`code: 'PATH_ERROR'`），可通过 `instanceof PathError` 捕获。

## `makeEvent(eventType, payload?, ctx?)`

```js
makeEvent(
  eventType: string,
  payload?: object,
  ctx?: { runId?: string, durationMs?: number }
): { event: string, type: string, ts: string, runId?: string, durationMs?: number, ...payload }
```

构造符合统一 FlowcastEvent schema 的事件对象。各模块（`cp.event` / `setAgentEventSink` / quality-gate `onEvent` / verify 等）的事件格式规范化辅助。

```js
import { makeEvent } from 'flowcast'

const evt = makeEvent('gate', { name: 'test', passed: true }, { runId: 'run-123', durationMs: 1500 })
// {
//   event: 'gate',      // 向后兼容：dashboard 和 run.log.jsonl 读 event 字段
//   type: 'gate',       // 新标准字段（与 event 同值）
//   ts: '2026-06-22T...',
//   runId: 'run-123',
//   durationMs: 1500,
//   name: 'test',
//   passed: true,
// }
```

**双字段兼容策略**：
- `event`：现有 `run.log.jsonl` 和 dashboard 使用此字段做路由（向后兼容，不能删）。
- `type`：新标准字段，与 `event` 保持同值，供未来统一迁移。

调用方直接用 `makeEvent`，不再手动构造 `{ event: ..., ts: ... }`。

## `loop(iterate, opts)`

goal-driven 循环原语。详见 [loop · memory · failure-context 指南](/guide/loop-memory)。

```js
import { loop } from 'flowcast'

const { status, turns, lastResult } = await loop(
  async ({ turn, goal, memorySection, lastVerdict }) => {
    return await runAgent(`${goal}\n\n${memorySection}`, { cli: 'claude' })
  },
  {
    goal: '修复所有 TypeScript 错误',
    isDone: async ({ turn, result }) => result?.includes('no errors'),
    gates: [{ name: 'tsc', cmd: 'npx tsc --noEmit', onFail: 'resume-fix' }],
    maxTurns: 10,
    memoryScope: 'ts-fix',
  }
)
```

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `goal` | `string` | 目标描述，注入每轮 iterate |
| `isDone` | `async ({turn, result, gateResults, state}) => boolean` | 达成判定（必填） |
| `gates` | `object[]` | 可选，每轮跑的质量门（传给 `runGates`） |
| `gateDeps` | `object` | `runGates` 的 deps（`resumeFix`/`onEvent`…） |
| `memoryScope` | `string` | 启用跨-run 记忆并按此 scope 读写 |
| `memoryQuery` | `string` | 召回 query（默认用 `goal`） |
| `maxTurns` | `number` | 轮数封顶（默认 20） |
| `maxRuntimeMs` | `number` | wall-clock 封顶（ms） |
| `runId` | `string` | Checkpoint run id（默认时间戳） |
| `stateDir` | `string` | Checkpoint 根目录（默认 `.flowcast/runs`；向后兼容 `.flowx/runs`） |
| `checkpoint` | `Checkpoint` | 复用外部 Checkpoint（优先于 runId） |
| `onEvent` | `(evt) => void` | 观测埋点 |

**返回值**：`{ status: 'completed' | 'budget_exhausted', turns, lastResult, runId }`

## `verifyAdversarial(claim, opts?)`

对抗式验证一个 claim：多个独立「怀疑者」尝试反驳，达到阈值则判定成立。

```js
import { verifyAdversarial } from 'flowcast'

const { verdict, survived, total, threshold } = await verifyAdversarial(
  '这段代码没有 SQL 注入漏洞',
  {
    lenses: ['correctness', 'security', 'edge-cases'],
    context: codeSnippet,
    agent: { cli: 'claude' },
  }
)
if (!verdict) throw new Error(`验证未通过：${survived}/${total} 票支持`)
```

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `voters` | `number` | 怀疑者数量（默认 3；给了 `lenses` 以 lenses 数为准） |
| `lenses` | `string[]` | 视角列表（`['correctness','security','repro']` 等） |
| `threshold` | `number` | 判定成立所需最少票数（默认过半） |
| `context` | `string` | 附加上下文（diff / 代码片段），拼进每个 prompt |
| `agent` | `object` | `runAgent` opts（`cli/model/provider…`） |

**返回值**：`{ verdict: boolean, survived, total, threshold, votes, voterErrors? }`

干跑 (`isDryRun()=true`) 时短路返回全票通过，不消耗 token。

## `validateSchema(value, schema, path?, opts?)` / `runStructured(runner, prompt, { schema })`

轻量 JSON Schema 校验与强制结构化输出。

```js
import { validateSchema, runStructured } from 'flowcast'

// 手工校验
const { ok, errors } = validateSchema({ name: 'alice', age: 30 }, {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name'],
})

// 强制 agent 结构化输出（内置 JSON 提取 + 校验 + 重试）
const result = await runStructured(
  (p) => runAgent(p, { cli: 'claude' }),
  '返回用户信息',
  { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
)
```

`runStructured` 失败（多次重试仍无法获得合法结构化输出）时抛 `SchemaError`。

## Memory API

```js
import { recordLearning, recall, buildMemorySection, promoteFailureContext } from 'flowcast'
```

轻量「跨-run」记忆，文件型 jsonl + 关键词/tag 召回。

| 函数 | 说明 |
|------|------|
| `recordLearning(scope, entry, opts?)` | 写入一条 learning（rootCause / fix / tags / runId） |
| `recall(scope, query, opts?)` | 按 query 关键词/tag 召回相关 learning 列表 |
| `buildMemorySection(scope, { query, baseDir? })` | 召回并格式化为可注入 prompt 的 Markdown 段落 |
| `promoteFailureContext(scope, failureContent, meta?, opts?)` | 把 failure-context 失败内容提升为持久化 learning（`failureContent` 为内容字符串，通常来自 `readAndConsumeFailureContext`） |

详见 [loop · memory · failure-context 指南](/guide/loop-memory)。

## `sweepStaleTmp({ olderThanMs, baseDir })`

扫 `tmpdir` 清理 stale 的 flowcast/flowx 临时文件。返回被清理的文件名列表。失败静默。

```js
import { sweepStaleTmp } from 'flowcast/internal'

// 通常在 bin/flowcast.js 启动时调一次
sweepStaleTmp({ olderThanMs: 60 * 60 * 1000 })  // 1h 前的全清
```

清理范围：

- `flowcast-codex-*` / 旧 `flowx-codex-*` —— codex adapter 临时输出
- `*-failure-context.md.consuming.*.owner.*` —— failure-context 跨进程消费 sidecar 残留

**不在主入口** `flowcast`：本函数在 `flowcast/internal`（无稳定性承诺，仅给 CLI 启动 / 工具脚本用）。

## 内部 helper（`flowcast/internal`）

下列 API 在 `flowcast/internal` 入口导出，**不保证稳定性**，仅供测试 / 工具脚本用。下游 flow 不要 import。

| 名称 | 用途 |
|------|------|
| `clearFlowcastDirCache` | `dirs.js` 缓存清空（测试用） |
| `sweepStaleTmp` | 同上 |
| `AGENT_COOLDOWN_BASE_MS` | agent 冷却默认值（30s） |
| `AGENT_COOLDOWN_MAX_MS` | agent 冷却上限（8min） |
