# Flow API 契约 — L3 codegen 的词汇表

> 生成的 flow **只能**用本契约列出的 flowx 原语，**只能** import `@force-lab/flowx`。
> 这是 codegen 的受控表面：有代码的表达力，又可审计、可 dry-run、可断点续跑。

## 调用约定（骨架强制）

每个生成的 flow 是一个可执行 JS 脚本，标准 CLI 参数：

| 参数 | 含义 |
|------|------|
| `--repo` | 目标仓路径（默认 cwd） |
| `--run-id` | run 标识（缺省自动生成；**续跑必须传同一个**） |
| `--goal` | 目标/需求文本 |
| `--agent` | 默认 agent profile 名（见 ~/.flowx/agents.*） |
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
| `runProfile(agentName, goal, extra?)` | 按 agent profile 名跑一次执行器（dry-run 自动 fake） |
| `resolveAgent(name, agents, {providers})` | 需要更细控制时直接解析 agent → `{run, opts}` |
| `runGate(gate, deps?)` | 单个质量门（`{name, cmd, cwd, onFail}`；onFail: rollback/resume-fix/autofix） |
| `runGates(gates, deps?)` | 顺序跑多个质量门 |
| `parallel(thunks, {concurrency?})` | 并行跑多个 `() => Promise`，某个失败返回 null 不中断；`concurrency` 限并发 |
| `runFlow(flowRef, opts)` | 把另一条 flow 当独立子进程跑（隔离+超时+续跑由其 `--run-id` 负责） |
| `fanOut(tasks, {concurrency?, isolate?, logDir?, onResult?})` | 并发编排多条子 flow：限并发 + 可选 worktree 隔离 + 每任务日志 + 结果汇总 |
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

- import 任何非 `@force-lab/flowx`（除 `util` 用于 parseArgs）。**禁止** `fs`/`child_process`/
  `net`/`http`/`os` 等——需要文件/进程/git 操作时只能通过 flowx 原语。
- 直接调 `process.exit` 之外的进程控制、动态 `require`/`import()` 任意模块。
- 在 `main()` 外写副作用逻辑（骨架结构之外）。

## few-shot

见 `orchestrator/examples/golden-sample.flow.js`：一个「并行多 agent 分析 → 质量门 → 综合收口」
的真实编排，100% 遵循本契约，可被 `validateFlow` 跑通。
