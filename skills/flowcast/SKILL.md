---
name: flowcast
description: >
  使用 flowcast 在任何业务项目里驱动 agent 自动完成任务——包括写 flow 文件、运行任务、
  排查失败、配置项目质量门。flowcast 全局安装，业务项目无需 package.json。
  Trigger when user mentions flowcast, wants to automate a dev task with agents, says things like:
  "用 flowcast 做 xxx", "帮我写一个 flow", "启动 force-dev", "flowcast 跑失败了",
  "配置质量门", "怎么续跑", "flowcast run", "flowcast orchestrate", "配置 flowcast",
  "/flowcast", "/flowcast-run", "/flowcast-create", "/flowcast-debug", "/flowcast-config".
---

# flowcast

> 详细参考文档在 `references/` 目录，本文件只做路由和快速参考。

## 0. 环境确认（每次先做）

```bash
which flowcast || npm install -g flowcast
```

业务项目**无需 package.json**，全局安装后直接可用。

---

## 1. 路由：用户想做什么？

| 用户说 | 走哪个场景 |
|--------|-----------|
| "帮我写一个 flow" / "自动化 xxx 流程" | → [写 flow](#write) |
| "用 flowcast 做 xxx" / "跑这个任务" | → [运行任务](#run) |
| "flow 报错了" / "怎么续跑" | → [排查失败](#debug) |
| "配置质量门" / "设置 model" | → [配置项目](#config) |

---

## 2. 写 flow {#write}

> 详细模板和步骤见 [references/create.md](references/create.md)

**flow 文件放在项目的 `.flowcast/flows/` 目录**，直接 import 包名：

```js
// .flowcast/flows/my-flow.js
import { Checkpoint, runAgent, fanOut, waitForInput } from 'flowcast'

const { values: opts } = parseArgs({ options: {
  'run-id': { type: 'string' },
  repo:     { type: 'string', default: process.cwd() },
}})
const cp = new Checkpoint(opts['run-id'] ?? `run-${Date.now()}`, `${opts.repo}/.flowcast/runs`)

await cp.step('p1.do-something', () => runAgent('...', { cli: 'claude' }))
cp.done({})
```

流程：**澄清步骤 → 确认分工 → 生成文件 → 说明运行方式**（不得跳过澄清直接生成）。

---

## 3. 运行任务 {#run}

> 命令速查见 [references/run.md](references/run.md)

先选命令：

| 场景 | 命令 |
|------|------|
| 开发 feature / 修 bug（完整闭环） | `flowcast force-dev --feature <name> --repo .` |
| 一句话需求，自动生成并执行 | `flowcast orchestrate "<需求>" --repo .` |
| 跑已有 flow 文件 | `flowcast run .flowcast/flows/xxx.js --repo .` |

**断点续跑**（HITL 暂停或进程中断后）：
```bash
flowcast force-dev --run-id <上次的 run-id> --repo .
flowcast run .flowcast/flows/xxx.js --run-id <上次的 run-id> --repo .
```

**解读输出**：
- `[run]  p1.xxx` — 正在执行
- `[skip] p1.xxx` — 续跑，已完成跳过
- `[paused]` — HITL 节点，处理后续跑
- `[error] p1.xxx: ...` — 步骤失败，看错误信息

---

## 4. 排查失败 {#debug}

> 常见错误模式见 [references/debug.md](references/debug.md)

```bash
# 1. 看 run 状态
cat .flowcast/runs/<run-id>/state.json | jq '{status, currentStep, pauseReason}'

# 2. 看失败步骤的输出
cat .flowcast/runs/<run-id>/run.log.jsonl | jq 'select(.status == "error")'
```

**最常见错误**：`[claude] exit 1` → claude CLI 在项目目录绑定了不可用的 model，
在 `.flowcast/config.json` 里加 `"agents": {"default": {"model": "claude-sonnet-4-6"}}` 解决。

**续跑 vs 重跑**：
- 续跑：传同一个 `--run-id`，已完成步骤自动跳过
- 重置某步：手动从 `state.json` 的 `completed` 里删掉对应 key，再续跑
- 全部重来：不传 `--run-id`，自动新建

---

## 5. 配置项目 {#config}

> 各语言模板见 [references/config.md](references/config.md)

在项目根创建 `.flowcast/config.json`：

```json
{
  "qualityGates": [
    { "name": "test",  "cmd": "cargo test",            "onFail": "resume-fix" },
    { "name": "build", "cmd": "cargo build",           "onFail": "rollback"   },
    { "name": "fmt",   "cmd": "cargo fmt --check",     "onFail": "autofix", "autofixCmd": "cargo fmt" }
  ],
  "agents": {
    "default":  { "cli": "claude", "model": "claude-sonnet-4-6" },
    "reviewer": { "cli": "claude", "model": "claude-sonnet-4-6",
                  "extraPromptPrefix": "你是该语言的专家审查者，重点关注安全和正确性。" }
  }
}
```

`onFail` 策略：`rollback`（硬回滚）/ `resume-fix`（喂给 agent 修）/ `autofix`（跑 autofixCmd）

**.gitignore 必加**：
```
.flowcast/runs/
.flowcast/memory/
.flowcast/prompt-*.md
```
