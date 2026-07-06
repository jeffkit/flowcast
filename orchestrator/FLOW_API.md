# Flow API 契约 — L3 codegen 的词汇表

> 生成的 flow **只能**用本契约列出的 flowcast 原语，**只能** import `flowcast`。
> 这是 codegen 的受控表面：有代码的表达力，又可审计、可 dry-run、可断点续跑。

## 调用约定（骨架强制）

每个生成的 flow 是一个可执行 JS 脚本，标准 CLI 参数：

| 参数 | 含义 |
|------|------|
| `--repo` | 目标仓路径（默认 cwd） |
| `--run-id` | run 标识（缺省自动生成；**续跑必须传同一个**） |
| `--goal` | 目标/需求文本 |
| `--agent` | 默认 agent profile 名（见 ~/.flowcast/agents.*，向后兼容 ~/.flowx/agents.*） |
| `--dry-run` | 结构冒烟：执行器/质量门被 fake，不烧 API、不跑构建 |
| `--hitl` | `terminal`（默认）/ `wecom` |
| `--project-name` | HITL 用的项目名 |

骨架已处理参数解析、`Checkpoint` 初始化、`loadAgents`/`loadProviders`、HITL 后端、
`runProfile` helper。**LLM 只填 `main()` 里 `// <<ORCHESTRATION>>` 处的编排逻辑。**

## 允许的原语

| 原语 | 用途 |
|------|------|
| `cp.step(name, fn)` | 把一个步骤纳入 checkpoint（断点续跑的最小单元）；name 唯一 |
| `cp.done(meta)` | 收尾，记录 metrics |
| `runProfile(agentName, goal, extra?)` | 按 agent profile 名跑一次执行器（dry-run 自动 fake）。`extra.schema` 传 JSON Schema 时**强制结构化输出**（校验+回喂重试），返回解析后的对象——需要结构化产物时**鼓励使用** |
| `resolveAgent(name, agents, {providers})` | 需要更细控制时直接解析 agent → `{run, opts}` |
| `runStructured(runner, prompt, {schema, retries?})` | 把任意 `(p)=>Promise<text>` runner 包成「强制返回校验过 JSON」的结构化调用；`runProfile` 的 schema 即基于它 |
| `runGate(gate, deps?)` | 单个质量门（`{name, cmd, cwd, onFail}`；onFail: rollback/resume-fix/autofix）——**确定性命令**验证 |
| `runGates(gates, deps?)` | 顺序跑多个质量门 |
| `loadGates({repo})` | 加载业务项目自定义质量门（`<repo>/.flowcast/gates.json`，map by name；与 `loadProviders`/`loadAgents` 对称），返回有序门数组 |
| `mergeGates(builtin, project)` | 合并内置默认门与项目门（按门名去重，项目同名覆盖，新增追加在后） |
| `verifyAdversarial(claim, {voters?, lenses?, threshold?, context?, agent?})` | **可选**对抗式验证：多个怀疑者独立尝试反驳 claim，过阈值才判成立。用于审计/bug 猎杀/高风险评审等确信度关键场景，与 `runGate` 互补，**非强制环** |
| `parallel(thunks, {concurrency?, strict?, failFast?, onError?})` | 并行跑多个 `() => Promise`（单层 barrier，等齐全部）；`concurrency` 限并发。**默认 `strict=true`**：任一失败则等全部跑完后汇总抛出 **`ParallelError`**（`err.failures` 含 `{index,error}` 数组）。传 `strict: false` 可改为「失败位置返回 null、其余继续」（适合部分失败可接受的批量场景；须检查结果中的 null）。`onError` 回调 `({index,error})=>void` 在 `strict:false` 时捕获各任务错误 |
| `pipeline(items, ...stages, {concurrency?, onError?}?)` | 流式流水线：每个 item 独立穿过所有 stage，**stage 间无 barrier**（快的先完成、零空等）。stage 签名 `(prev, item, index)`；末位可传 `{concurrency, onError}`。某 item 在任一 stage 失败则该 item 位置为 null，`onError` 回调 `({index, item, error})=>void` 是区分「失败」和「任务本身返回 null」的唯一可靠手段。需要某 stage 看到全部上游结果时改用 `parallel` 收口 |
| `runFlow(flowRef, opts)` | 把另一条 flow 当独立子进程跑（隔离+超时+续跑由其 `--run-id` 负责）。返回：`{ ok, exitCode, stdout, stderr, timedOut?, spawnError? }` |
| `fanOut(tasks, {concurrency?, isolate?, logDir?, prepare?, onResult?, onData?, cleanWorktrees?})` | 并发编排多条子 flow：限并发 + 可选 worktree 隔离 + 每任务日志 + 结果汇总。`prepare` 钩子在隔离后、跑 flow 前执行；`onData` 实时输出回调。**`prepare`/`onResult` 抛错为硬失败**：整批 fanOut reject，`err.partialResults` 含已完成结果；子 flow 非零退出为软失败，返回 `result.ok === false` 且不 reject。`cleanWorktrees` 默认 `false`（保留现场便于调试）；**长期/循环使用时建议传 `cleanWorktrees: true`** 以避免 `.worktrees/` 无限堆积 |
| `loop(iterate, {goal, isDone, gates?, maxTurns?, maxRuntimeMs?, memoryScope?, runId?, stateDir?, onEvent?})` | goal-driven 循环原语：每轮 fresh context 迭代，复用 Checkpoint 续跑，每轮跑质量门硬验证，可选写入跨-run 记忆。`iterate` 签名 `async ({turn, goal, memorySection, lastVerdict, lastResult})=>result`；`isDone` 签名 `async ({turn,result,gateResults,state})=>boolean`。返回 `{status,turns,lastResult,runId}`，`status ∈ 'completed'|'budget_exhausted'` |
| `recordLearning(entry, {scope, baseDir?})` | 跨-run 记忆写入：把经验/教训追加进 `<baseDir>/<scope>.jsonl`。`entry` 形状 `{topic,rootCause,fix,tags?,runId?}` |
| `recall(query, {scope, baseDir?, maxEntries?})` | 跨-run 记忆召回：按关键词/tag 匹配相关历史条目，返回 `{entries, total}` |
| `buildMemorySection(query, {scope, baseDir?, maxEntries?})` | 把召回结果格式化成可注入 prompt 的 Markdown 段落（供 `iterate` 使用） |
| `gitWorktreeAdd(repo, dir)` / `gitWorktreeRemove(repo, dir)` | 受控 git worktree（给 fanOut 做每任务隔离用） |
| `withSelfModGuard(fn, {repo, baseline})` | 自改安全沙箱：失败硬回滚（需要先 `captureBaseline`） |
| `captureBaseline(repo, {requireClean})` | 捕获 git baseline |
| `waitForInput(prompt)` | HITL：阻塞等人工输入 |
| `notify(message)` | HITL：单向通知 |
| `writeFailureContext(dir, tag, info)` | 失败上下文落盘（下次注入 prompt） |
| `gitCommitAll(repo, message)` | 暂存全部并提交（dry-run 下不实际提交）；需要 commit 时用它，**不要**裸调 shell |
| `gitDiff(repo, {staged})` / `gitStatus(repo)` | 看 diff / 工作树状态 |
| `isDryRun()` | 是否 dry-run（用于跳过真实副作用，如 requireClean） |

## 禁止项（validateFlow 会拦截）

- import 任何非 `flowcast`（除 `util` 用于 parseArgs）。**禁止** `fs`/`child_process`/
  `net`/`http`/`os` 等——需要文件/进程/git 操作时只能通过 flowcast 原语。
- import `flowcast` 的子路径（如 `flowcast/dashboard`）。`flowcast` 必须作为整体被 import，
  子路径视为「宿主 CLI/SDK 才用、不该被编排对象自循环」的能力（dashboard 等）。
- 从 `flowcast` 导入底层进程原语 **`spawnCapture`**/**`spawnCli`**。这两个函数可以执行任意子进程，
  绕过 flow 的受控执行边界；需要子进程功能时使用 `runGate`（质量门）或 `runFlow`（子 flow）。
  ⚠️ `import * as fc from 'flowcast'; fc.spawnCapture(...)` 形式静态检查无法拦截，但同样被本契约禁止。
- 直接调 `process.exit` 之外的进程控制、动态 `require`/`import()` 任意模块。
- 在 `main()` 外写副作用逻辑（骨架结构之外）。

## few-shot

见 `orchestrator/examples/golden-sample.flow.js`：一个「并行多 agent 分析 → 质量门 → 综合收口」
的真实编排，100% 遵循本契约，可被 `validateFlow` 跑通。
