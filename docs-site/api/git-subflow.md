# API · Git / Subflow

受控 git 原语（给生成的 flow 用，绕开 `child_process` 白名单）+ 子 flow 调度。

```js
import {
  gitStatus, gitDiff, gitHead, gitCurrentBranch, gitCommitsAhead,
  gitCreateBranch, gitCommitAll, gitWorktreeAdd, gitWorktreeRemove,
  runFlow, fanOut, archiveChildRun,
} from '@force-lab/flowx'
```

## Git 原语

生成的 flow 受 import 白名单约束（不能直接用 `child_process`），但常需要 git。flowx 暴露这组受控 helper：

| 函数 | 作用 | 返回 |
|------|------|------|
| `gitStatus(repo?)` | 工作树改动（porcelain） | string |
| `gitDiff(repo?, { staged? })` | diff（默认未暂存；`staged` 看已暂存） | string |
| `gitHead(repo?)` | 当前 HEAD 完整 sha | string |
| `gitCurrentBranch(repo?)` | 当前分支名（detached 返回 `HEAD`） | string |
| `gitCommitsAhead(repo?, baseRef='main')` | HEAD 相对 baseRef 领先的提交数 | number |
| `gitCreateBranch(repo?, name)` | 建/切分支（已存在则切换） | `{ branch, created, dryRun? }` |
| `gitCommitAll(repo?, message?)` | 暂存全部并提交（无改动跳过） | `{ committed, sha?, reason?, dryRun? }` |
| `gitWorktreeAdd(repo?, dir, { ref? })` | 新增隔离 worktree（已存在则复用） | `{ dir, created, reason?, dryRun? }` |
| `gitWorktreeRemove(repo?, dir, { force=true })` | 移除 worktree | `{ dir, removed, dryRun? }` |

副作用型操作（`gitCreateBranch` / `gitCommitAll` / `gitWorktreeAdd` / `gitWorktreeRemove`）在 `isDryRun()` 下**不实际执行**，返回 `dryRun: true`。

::: tip 为什么不裸调 git
按 [FLOW_API](/api/) 契约，生成的 flow 需要 git/文件操作时**只能**走 flowx 暴露的原语，不能裸调 shell。这样契约不破，且 dry-run 可空跑。
:::

## 子 flow 调度

### runFlow(flowRef, opts)

把一个 flow 文件当**独立 node 子进程**跑（隔离 + 超时可控；崩溃不污染宿主）。

```js
const r = await runFlow('./flows/force-dev.js', {
  repo, runId, goal, agent,
  args: ['--feature', 'x'],   // 额外原样透传的 CLI 参数
  cwd: repo, timeout,         // 超时 ms（到点 SIGKILL）
  dryRun,                     // 默认继承 isDryRun()
  onData: (s) => process.stdout.write(s),   // 实时输出（不写 logFile 时生效）
  logFile,                    // 给了则把 stdout/stderr 重定向到该文件（并发避免交错）
})
// → { ok, exitCode, stdout, stderr, spawnError? }
```

只注入"调用方明确给了"的标准参数，避免污染不认识这些 flag 的 flow。续跑由子 flow 自身的 `--run-id` + Checkpoint 负责。

### fanOut(tasks, opts)

并发跑多个子 flow：限并发 + 可选 worktree 隔离 + 每任务日志 + 结果按序汇总。这是「拆多组 → 各自跑 flow → 并发 → 隔离 → 汇总」的通用底座，手写编排与 L3 分拆共用。

```js
const results = await fanOut(
  [
    { name: 'task-a', flow: './flows/force-dev.js', runId: 'a', goal: '...', agent: 'claude-sonnet', args: [] },
    { name: 'task-b', flow: './flows/force-dev.js', runId: 'b', goal: '...' },
  ],
  {
    repo,
    concurrency: 2,          // 并发上限（默认 1）
    isolate: 'worktree',     // 'worktree' | 'none'（默认 none）
    worktreesDir,            // worktree 根（默认 <repo>/.worktrees）
    timeout, dryRun, logDir,
    prepare: async (task, { cwd, worktree }) => { /* 隔离后、跑 flow 前钩子 */ },
    onResult: async ({ task, result, worktree }) => { /* 每任务完成回调 */ },
  },
)
// → [{ task, result, worktree? }]（按 tasks 原序）
```

checkpoint 记录交给调用方：用 `cp.has` 过滤已完成、`cp.record` 在 `onResult` 里回写。

### archiveChildRun(repo, worktree, childRunId)

把 worktree 内某条子 run 的状态（`state.json` / `run.log.jsonl`）镜像回主仓 `.flowx/runs`，让看板能在主仓一处稳定读到（worktree 会被复用/清理，观测数据否则会丢）。纯保全操作，失败只告警。

指南见 [示例 · todo-drain](/guide/examples)。
