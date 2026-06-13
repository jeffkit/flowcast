# loop · memory · failure-context

这三个原语构成 flowcast 的「越跑越聪明」能力栈：

- **`loop`**：goal-driven 循环（每轮 fresh context 迭代，复用 Checkpoint 续跑）
- **`memory`**：跨-run 经验沉淀（append-only jsonl，关键词/tag 召回）
- **`failure-context`**：单轮失败上下文（写入即消费的热路径注入）

---

## loop — goal-driven 循环原语

`loop` 抽象当下流行的 agent loop 模式（Cursor /loop · Ralph Loop · cursor-goal）：**每轮 fresh context 迭代 → 读上轮持久状态 → 跑硬验证门 → 写记忆 → 判达成**。

与「一条 flow 跑完就退」相比，`loop` 让 flowcast 能反复跑到目标达成；但它仍是**同步函数、跑完即返**，不是 daemon——谁来周期性调用它（cron / 人工 / 产品仓）是上层的事。

### 最小示例

```js
import { loop, runAgent } from 'flowcast'

const result = await loop(
  async ({ turn, goal, memorySection }) => {
    return runAgent(`${memorySection}\n\n目标：${goal}\n\n第 ${turn} 轮，继续推进。`, {
      cli: 'claude',
      cwd: repo,
    })
  },
  {
    goal: '把 test suite 的覆盖率提升到 80%',
    isDone: async ({ gateResults }) => gateResults.every((g) => g.ok),
    gates: [{ name: 'test', cmd: 'npm test', onFail: 'resume-fix' }],
    maxTurns: 10,
    runId: `coverage-${Date.now()}`,
    stateDir: `${repo}/.flowx/runs`,
  },
)

console.log(result.status, result.turns)
// 'completed' 7
```

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `iterate` | `async ({turn, goal, memorySection, lastVerdict, lastResult}) => result` | 单轮工作体，每轮 fresh context |
| `goal` | string | 目标描述，注入每轮 iterate |
| `isDone` | `async ({turn, result, gateResults, state}) => boolean` | 达成判定 |
| `gates` | object[] | 可选，每轮跑的质量门（复用 `runGates`） |
| `maxTurns` | number | 轮数封顶（默认 20） |
| `maxRuntimeMs` | number | 可选 wall-clock 封顶 |
| `memoryScope` | string | 启用跨-run 记忆并按此 scope 读写 |
| `runId` / `stateDir` | string | Checkpoint 参数（支持续跑） |
| `checkpoint` | Checkpoint | 复用外部 Checkpoint（优先于 runId/stateDir） |

### 返回值

```js
{ status: 'completed' | 'budget_exhausted', turns: number, lastResult: any, runId: string }
```

### 续跑

`loop` 内部用 `Checkpoint` 把每一轮记为 `turn-N` 步骤。中断后传同一 `runId` 重跑，已完成的轮自动跳过：

```js
// 首次跑
await loop(iterate, { goal, isDone, runId: 'my-loop-001', stateDir: '.flowx/runs' })

// 续跑（传同一 runId）
await loop(iterate, { goal, isDone, runId: 'my-loop-001', stateDir: '.flowx/runs' })
```

---

## memory — 跨-run 经验沉淀

`memory` 提供文件型的跨-run 记忆（append-only `.jsonl`），让 flow 能从历史失败和进展中学习。

设计原则：**刻意简单**——关键词/tag 召回，零依赖，接口稳定，日后可替换为向量召回。

### 写入经验

```js
import { recordLearning } from 'flowcast'

recordLearning('force-dev', {
  topic: '单测跑不过：mock 没 reset',
  rootCause: 'Jest 的 mock 在 beforeEach 没清除导致测试间污染',
  fix: '在 beforeEach 加 jest.clearAllMocks()',
  tags: ['test', 'jest', 'mock'],
  runId: cp.runId,
})
```

### 召回并注入 prompt

```js
import { buildMemorySection } from 'flowcast'

const memorySection = buildMemorySection('force-dev', {
  query: '单测 mock 失败',  // 关键词检索
  topK: 5,
})

// memorySection 是一段 Markdown，直接拼进 prompt
const prompt = `${memorySection}\n\n任务：...`
```

### 存储位置

```
<repo>/.flowx/memory/<scope>.jsonl
```

默认在 `.flowx/memory/`（可用 `baseDir` 覆盖）。每行一条 JSON 记录：

```json
{"ts":"2026-01-01T00:00:00.000Z","topic":"...","rootCause":"...","fix":"...","tags":["test"],"runId":"run-123"}
```

### 与 loop 配合

```js
await loop(
  async ({ goal, memorySection }) => {
    return runAgent(`${memorySection}\n\n目标：${goal}`, { cli: 'claude', cwd: repo })
  },
  {
    goal: '通过所有 E2E 测试',
    isDone: async ({ gateResults }) => gateResults.every((g) => g.ok),
    memoryScope: 'e2e-fix',      // 开启跨-run 记忆
    memoryQuery: 'E2E 测试失败', // 召回关键词（默认用 goal）
    gates: [{ name: 'e2e', cmd: 'npm run test:e2e', onFail: 'resume-fix' }],
  },
)
```

开启 `memoryScope` 后，`loop` 会自动在每轮完成后调用 `recordLearning`，下一轮的 `memorySection` 参数就包含历史经验。

---

## failure-context — 单轮失败上下文

`failure-context` 是热路径注入：失败时写一份结构化上下文，下次重试时注入 agent prompt，读取后即删除（只注入一次）。

> 与 `memory` 的区别：`failure-context` 是**单轮、写入即消费**；`memory` 是**跨-run、长期累积**。

### 在 quality-gate 的 resume-fix 回调里写入

```js
import { writeFailureContext, readAndConsumeFailureContext } from 'flowcast'

await runGate({
  name: 'test',
  cmd: 'npm test',
  cwd: repo,
  onFail: 'resume-fix',
  // resume-fix 触发时，把上下文写进 runDir，供下轮 agent 读取
  resumeFix: async ({ output }) => {
    writeFailureContext(runDir, 'test', {
      reason: 'npm test 失败',
      tailLog: output.slice(-2000),
    })
    await runAgent(readAndConsumeFailureContext(runDir, 'test') + '\n\n修复测试失败', {
      cli: 'claude',
      cwd: repo,
    })
  },
})
```

### API

```js
// 写入失败上下文
writeFailureContext(dir, tag, { reason, tailLog, provider, model })

// 读取并消费（删除）失败上下文，无则返回 null
const ctx = readAndConsumeFailureContext(dir, tag)
```

文件落在 `<dir>/<tag>-failure-context.md`，格式为结构化 Markdown，可直接拼进 agent prompt。

### 升级到跨-run：promoteFailureContext

如果一次失败值得长期记住（超过单轮），用 `promoteFailureContext` 把它提升为 memory 条目：

```js
import { promoteFailureContext } from 'flowcast'

promoteFailureContext(runDir, 'test', 'force-dev', {
  topic: '测试失败：类型不匹配',
  tags: ['typescript', 'type-error'],
  runId: cp.runId,
})
```
