# 快速上手

本节带你在几分钟内安装 flowx、写出第一个可断点续跑的 flow，并跑通 CLI。

## 环境要求

- **Node ≥ 20**（纯 ESM，需要原生 `parseArgs` 等能力）
- 一个 git 仓库（flow 的 git/worktree 原语依赖它）

## 安装

flowx 设计为**作为库被项目消费**。推荐用 `file:` 依赖把它接进你的项目仓：

```bash
# 1. 克隆 flowx
git clone https://github.com/jeffkit/flowx.git ~/projects/flowx

# 2. 在你的项目仓里以 file: 依赖引入
cd ~/projects/your-repo
npm install ~/projects/flowx
```

或直接从 npm 安装（如果已发布）：

```bash
npm install @force-lab/flowx
```

::: tip 为什么用 file: 依赖
L3 编排会**生成 import 本包的 flow 代码**，因此目标仓必须能解析 `@force-lab/flowx`。
`orchestrate` 会在跑前预检 `checkFlowxResolvable`，缺依赖时毫秒级 fail-fast 并给出 `npm install` 指引。
:::

安装后即可用 CLI：

```bash
npx flowx --help
# 或把 bin 软链到 PATH 后直接 flowx --help
```

## 第一个 flow

一个 flow 就是一个普通的可执行 JS 脚本。下面这个 flow 把工作拆成两个**可断点续跑**的步骤：

```js
// flows/hello.js
import { parseArgs } from 'util'
import { Checkpoint, setWorkdir, runAgent } from '@force-lab/flowx'

const { values: opts } = parseArgs({ options: {
  'run-id': { type: 'string' },
  repo:     { type: 'string', default: process.cwd() },
  'dry-run':{ type: 'boolean', default: false },
} })

if (opts['dry-run']) process.env.FLOWX_DRY_RUN = '1'

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
FLOWX_DRY_RUN=1 flowx run ./flows/hello.js
# 或
flowx run ./flows/hello.js --dry-run
```

你会看到每个 step 被记录到 `.flowx/runs/<run-id>/`：

```
.flowx/runs/hello-1234567890/
├── state.json       # status、各步骤完成情况、暂停原因
├── run.log.jsonl    # 每步耗时、输入输出、错误（完整审计）
└── report.md        # 可读摘要（done 后生成）
```

## 断点续跑

如果 flow 在中途崩溃或被你 Ctrl-C，**用同一个 `--run-id` 再跑一次**即可从断点继续，已完成的步骤会被跳过：

```bash
flowx run ./flows/hello.js --run-id hello-1234567890
#   [skip] plan
#   [run]  implement
```

这就是 flowx 最核心的保证：**步骤跳过准确率 100%，已完成步骤零重复执行**。详见 [断点续跑](/guide/checkpoint)。

## 用 CLI 一行需求跑 L3 编排

不想自己写 flow？让 L3 替你**生成并执行**：

```bash
# 一行需求 → 生成 flow → 校验（语法 + import 白名单 + dry-run）→ 执行（续跑锁定）
flowx orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet

# 大目标：先分拆成子任务，每个生成一条 flow，fanOut 并发执行
flowx orchestrate "把 README 的 TODO 全部实现" --split --concurrency 3

# 续跑：复用已生成的 flow.mjs
flowx orchestrate "..." --run-id orch-123
```

详见 [L3 编排](/guide/orchestration)。

## 可观测看板

随时把所有 run 的状态生成一张只读 HTML 看板：

```bash
flowx dashboard --repo . --open
# → .flowx/dashboard.html（父子运行树 + 僵尸进程推断 + 质量门红灯）
```

## CLI 速查

| 命令 | 作用 |
|------|------|
| `flowx force-dev --feature x --repo .` | 跑内置 force-dev flow（建分支 → 写码 → 审查 → PR） |
| `flowx orchestrate "<目标>" --repo .` | L3：一行需求 → 生成 → 校验 → 执行 |
| `flowx orchestrate "<大目标>" --split` | L3 接单分拆：拆子任务 → 各自生成 → fanOut 并发 |
| `flowx dashboard --repo . [--open]` | 生成只读可观测看板 HTML |
| `flowx run <flow.js> [args]` | 跑任意自定义 flow |
| `flowx list` | 列出当前项目所有 run |

下一步：理解 [三层架构](/guide/architecture)。
