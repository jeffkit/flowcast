# 快速上手

本节带你在几分钟内安装 flowcast、写出第一个可断点续跑的 flow，并跑通 CLI。

## 环境要求

- **Node ≥ 20**（纯 ESM，需要原生 `parseArgs` 等能力）
- 一个 git 仓库（flow 的 git/worktree 原语依赖它）

## 安装

flowcast 有两种使用方式：

### 全局安装 CLI（推荐）

```bash
npm install -g flowcast
flowcast --help
```

全局安装后，`flowcast`（或 `flowc`/`fc`）命令在任何目录都可用。业务项目**无需**自己的 `package.json` 或 `node_modules`。

### 项目内安装（用于 L3 orchestrate）

L3 编排会**生成 import 本包的 flow 代码**，生成的 flow 需要在目标仓解析 `flowcast`：

```bash
cd <目标仓> && npm install flowcast
```

`orchestrate` 在跑前会预检 `checkFlowcastResolvable`，缺依赖时毫秒级 fail-fast 并给出安装指引。

### 安装社区 / 团队 flow

flow 是独立的 JS 文件，可从任何来源安装到 `~/.flowcast/flows/`：

```bash
# 从本地路径安装
flowcast flows install ./path/to/my-flow.js

# 查看已安装的 flow
flowcast flows list

# 移除
flowcast flows remove my-flow
```

安装后即可按名字运行，无需指定路径：

```bash
flowcast run my-flow --repo .
```

## 初始化配置（新用户第一步）

装好 CLI 后，**先用 `init` 自动扫描本机环境并生成配置**：

```bash
flowcast init
```

`init` 会扫描 PATH 中的 agent CLI（claude/cursor/gemini/codex/aider/...）及其登录凭证，交互式让你选要生成 profile 的 CLI 和默认 agent，对 BYO-LLM CLI（claude/aider）补问 provider（API key 用 `${ENV}` 形式，明文不入仓），最后写入 `~/.flowcast/agents.json` + `~/.flowcast/providers.json`（已有则 `.bak` 备份）。

- 想跳过交互（CI/脚本）：`flowcast init --yes`
- 想自检环境是否就绪（只读，不写盘）：`flowcast doctor`
- 想手写配置而非用 init：见 [配置分层](/guide/configuration)

`doctor` 会逐项检查 Node/git、每个 CLI 的 PATH 与凭证、agents/providers 配置合法性、flowcast 包能否被当前 repo 解析，每条 ✗ 给出具体修复建议。

## 第一个 flow

一个 flow 就是一个普通的可执行 JS 脚本。下面这个 flow 把工作拆成两个**可断点续跑**的步骤：

```js
// flows/hello.js
import { parseArgs } from 'util'
import { Checkpoint, setWorkdir, runAgent } from 'flowcast'

const { values: opts } = parseArgs({ options: {
  'run-id': { type: 'string' },
  repo:     { type: 'string', default: process.cwd() },
  'dry-run':{ type: 'boolean', default: false },
} })

if (opts['dry-run']) process.env.FLOWCAST_DRY_RUN = '1'

const runId = opts['run-id'] ?? `hello-${Date.now()}`
setWorkdir(opts.repo)
const cp = new Checkpoint(runId)

// step 的 key 唯一；续跑时已完成的 step 会被跳过（[skip]）
const plan = await cp.step('plan', () =>
  runAgent('列出实现 X 功能需要改动的文件', { cli: 'claude' }))

const code = await cp.step('implement', () =>
  runAgent(`按这个计划实现：\n${plan}`, { cli: 'claude' }))

cp.done({ files: 'see implement step' })
console.log(String(code))
```

跑它（dry-run 不烧 API，先验证骨架）：

```bash
FLOWCAST_DRY_RUN=1 flowcast run ./flows/hello.js
# 或
flowcast run ./flows/hello.js --dry-run
```

你会看到每个 step 被记录到 `.flowcast/runs/<run-id>/`：

```
.flowcast/runs/hello-1234567890/
├── state.json       # status、各步骤完成情况、暂停原因
├── run.log.jsonl    # 每步耗时、输入输出、错误（完整审计）
└── report.md        # 可读摘要（done 后生成）
```

## 断点续跑

如果 flow 在中途崩溃或被你 Ctrl-C，**用同一个 `--run-id` 再跑一次**即可从断点继续，已完成的步骤会被跳过：

```bash
flowcast run ./flows/hello.js --run-id hello-1234567890
#   [skip] plan
#   [run]  implement
```

这就是 flowcast 最核心的保证：**步骤跳过准确率 100%，已完成步骤零重复执行**。详见 [断点续跑](/guide/checkpoint)。

## 用 CLI 把编排需求交给 L3

不想自己写 flow？把一段**多步骤的编排需求**交给 L3，让它**生成 flow 并执行**（适合需要流程设计、断点续跑的任务；一句话能搞定的单步任务直接用 `claude`/`cursor` 即可）：

```bash
# 编排需求 → 生成 flow → 校验（语法 + import 白名单 + dry-run）→ 执行（续跑锁定）
flowcast orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet

# 大目标：先分拆成子任务，每个生成一条 flow，fanOut 并发执行
flowcast orchestrate "把 README 的 TODO 全部实现" --split --concurrency 3

# 续跑：复用已生成的 flow.mjs
flowcast orchestrate "..." --run-id orch-123
```

详见 [L3 编排](/guide/orchestration)。

## 可观测看板

随时把所有 run 的状态生成一张只读 HTML 看板：

```bash
flowcast dashboard --repo . --open
# → .flowcast/dashboard.html（父子运行树 + 僵尸进程推断 + 质量门红灯）
```

## CLI 速查

| 命令 | 作用 |
|------|------|
| `flowcast init` | 交互式扫描本机 agent CLI + 生成 `~/.flowcast` 配置（新用户第一步） |
| `flowcast doctor [--repo .]` | 自检环境健康（Node/git/CLI/配置），只读 |
| `flowcast run <name\|file> [args]` | 按名字运行已安装的 flow，或直接运行 flow 文件 |
| `flowcast run <flow> --supervise` | 跑 flow，挂了让 agent 自动修 flow、用同一 runId 续跑直到跑通 |
| `flowcast flows list` | 列出 `~/.flowcast/flows/` 下已安装的 flow |
| `flowcast flows install <file>` | 安装 flow 到 `~/.flowcast/flows/` |
| `flowcast flows remove <name>` | 移除已安装的 flow |
| `flowcast orchestrate "<编排需求>" --repo .` | L3：编排需求 → 生成 flow → 校验 → 执行（多步任务才值得用） |
| `flowcast orchestrate "<大目标>" --split` | L3 接单分拆：拆子任务 → 各自生成 → fanOut 并发 |
| `flowcast dashboard --repo . [--open]` | 生成只读可观测看板 HTML |
| `flowcast list` | 列出当前项目所有 run |

## v0.5.0 新增亮点

| 能力 | 说明 |
|------|------|
| **完整错误层次体系** | `FlowcastError` 基类 + 11 个子类（`ParallelError` / `VerifyError` / `LockError` / `GitError` / `GuardError` 等），所有错误可 `instanceof` 分支处理。 |
| **`parallel` 行为变更** | 默认 `strict=true`：任一失败等所有完成后汇总抛 `ParallelError`（v0.3.0 起）。新增 `failFast` / `onError` 参数。 |
| **新主入口导出** | `spawnCli` / `emitAgentEvent` / `claudeApplyProvider` / `makeEvent` / `loadGates` / `mergeGates` / `validateSchema` / `runStructured` / `verifyAdversarial` / `loop` / 所有记忆 API。 |
| **外置质量门配置** | `loadGates({repo})` + `mergeGates(builtin, project)` 支持项目仓 `.flowcast/gates.json` 声明自定义门。 |

详见 [更新日志](https://github.com/jeffkit/flowcast/commits/main) 与 [错误类型 API](/api/errors)。

---

下一步：理解 [三层架构](/guide/architecture)。
