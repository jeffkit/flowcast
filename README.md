# flowcast

轻量 workflow 编排框架：**断点续跑 · HITL · 多 CLI/agent 调度 · 自改安全沙箱 · 质量门**，以及其上的 **L3 codegen 编排层**（一行需求 → 动态生成 flow → 隔离执行）。

零运行时依赖 · 纯 ESM · Node ≥ 20

[![npm](https://img.shields.io/npm/v/flowcast)](https://www.npmjs.com/package/flowcast)
[![license](https://img.shields.io/npm/l/flowcast)](LICENSE)

**[完整文档](https://jeffkit.github.io/flowx/)**

---

## 30 秒上手

```bash
# 全局安装
npm install -g flowcast

# 一行需求 → 生成 flow → 校验 → 执行
flowcast orchestrate "把 README 里的 TODO 清单逐条实现" --repo .

# 干跑验证结构（不烧 API）
FLOWCAST_DRY_RUN=1 flowcast run ./my-flow.js
```

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **断点续跑** | `Checkpoint` 把 flow 拆成可持久化的步骤，中断后传同一 `run-id` 续跑，已完成步骤零重复执行 |
| **HITL** | 可插拔 HITL 后端（terminal / 企业微信），在关键节点阻塞等待人工决策 |
| **多 CLI/agent 调度** | `claude / cursor / gemini / codex / aider / recursive` 各有 adapter，统一 `runAgent` 驱动，可路由、可并行、可互换 |
| **自改安全沙箱** | `withSelfModGuard` 隔离自改，质量门失败硬回滚，让 agent 安全地改自己的代码 |
| **质量门** | `runGate / runGates` 把测试、lint、构建纳入 flow，失败可 rollback / resume-fix / autofix |
| **goal-driven 循环** | `loop` 原语：每轮 fresh context 迭代 + 可选跨-run 记忆 + 质量门验证 + budget 封顶 |
| **L3 codegen 编排** | `orchestrate`：需求 → 受约束生成 flow → 三道护栏校验 → 子进程隔离执行（续跑锁定） |
| **并发子 flow** | `fanOut` 限并发 + worktree 隔离；`runFlow` 把任意 flow 当隔离子进程跑 |
| **可观测看板** | `flowcast dashboard` 扫描运行状态，生成只读单文件 HTML 看板 |

---

## 三层架构

```
L3 编排层 (orchestrator/)         接单 → 动态生成 flow → 校验 → 执行（续跑锁定）
L2 引擎   (核心原语)              Checkpoint / 自改沙箱 / 质量门 / HITL / loop / dry-run
L1 执行器 (agent.js + executor.js) 怎么驱动一个 CLI/agent + provider 能力分层 + 路由
```

---

## 安装

### 全局 CLI（推荐）

```bash
npm install -g flowcast
```

全局安装后，`flowcast`（或 `flowc` / `fc` / `flowx`）命令在任何目录可用，业务项目无需自己的 `node_modules`。

### 项目内安装

```bash
npm install flowcast
```

L3 `orchestrate` 会生成 `import flowcast` 的 flow 代码，目标仓需能解析本包（跑前预检，缺依赖 fail-fast 并给出安装指引）。

---

## 写一个 flow

```js
// .flowx/flows/my-flow.js
import { parseArgs } from 'util'
import { Checkpoint, runAgent } from 'flowcast'

const { values: opts } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    repo: { type: 'string', default: process.cwd() },
  },
})

const cp = new Checkpoint(opts['run-id'] ?? `run-${Date.now()}`, `${opts.repo}/.flowx/runs`)

await cp.step('p1.generate', () => runAgent('实现 XXX 功能', { cli: 'claude', cwd: opts.repo }))
await cp.step('p2.review',   () => runAgent('review 上一步的改动', { cli: 'claude', cwd: opts.repo }))

cp.done({ summary: 'done' })
```

```bash
# 首次跑
flowcast run .flowx/flows/my-flow.js --repo .

# 中断后续跑（传同一 run-id）
flowcast run .flowx/flows/my-flow.js --run-id run-1234567890 --repo .
```

---

## 配置

在项目根创建 `.flowx/config.json`（committed）：

```json
{
  "qualityGates": [
    { "name": "test",  "cmd": "npm test",     "onFail": "resume-fix" },
    { "name": "lint",  "cmd": "npm run lint",  "onFail": "autofix", "autofixCmd": "npm run lint:fix" }
  ],
  "agents": {
    "default":  { "cli": "claude", "model": "claude-sonnet-4-6" }
  }
}
```

机器级密钥放 `~/.flowx/providers.json`（gitignore），用 `${ENV_VAR}` 插值，明文永不入仓。

---

## CLI 命令

```bash
flowcast orchestrate "<需求>" --repo .          # L3：需求 → 生成 flow → 执行
flowcast orchestrate "<需求>" --split --repo .  # 大目标拆子任务 → 并发执行
flowcast run <flow-file> [--run-id <id>]        # 跑 flow（续跑传同一 id）
flowcast force-dev --feature <name> --repo .    # 运行内置 force-dev flow
flowcast dashboard --repo . [--open]            # 生成可观测看板 HTML
flowcast list --repo .                          # 列出所有 run
```

---

## 环境要求

- Node.js ≥ 20
- Git（worktree / 自改沙箱依赖）

---

## 许可证

MIT
