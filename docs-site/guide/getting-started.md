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

## 用 CLI 一行需求跑 L3 编排

不想自己写 flow？让 L3 替你**生成并执行**：

```bash
# 一行需求 → 生成 flow → 校验（语法 + import 白名单 + dry-run）→ 执行（续跑锁定）
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
| `flowcast run <name\|file> [args]` | 按名字运行已安装的 flow，或直接运行 flow 文件 |
| `flowcast flows list` | 列出 `~/.flowcast/flows/` 下已安装的 flow |
| `flowcast flows install <file>` | 安装 flow 到 `~/.flowcast/flows/` |
| `flowcast flows remove <name>` | 移除已安装的 flow |
| `flowcast orchestrate "<目标>" --repo .` | L3：一行需求 → 生成 → 校验 → 执行 |
| `flowcast orchestrate "<大目标>" --split` | L3 接单分拆：拆子任务 → 各自生成 → fanOut 并发 |
| `flowcast dashboard --repo . [--open]` | 生成只读可观测看板 HTML |
| `flowcast list` | 列出当前项目所有 run（需安装 force-dev flow） |

下一步：理解 [三层架构](/guide/architecture)。
