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

**目录约定（v0.2.0）**：

- 新项目用 `.flowcast/`；旧项目 `.flowx/` 仍 fallback 向后兼容
- dry-run（`FLOWCAST_DRY_RUN=1`）所有状态写到 `~/.flowcast/dryrun/`（或 `~/.flowx/dryrun/`），不污染真盘
- flowcast 启动时**自动调用** `sweepStaleTmp` 清 1h+ 前的临时文件（无需手动）

**bin 入口**：v0.2.0 已是 `bin/flowcast.js`（旧 `bin/flowx.js` 作为别名保留向后兼容）。用 `flowcast --help` 查命令。

---

## 1. 路由：用户想做什么？

| 用户说 | 走哪个场景 |
|--------|-----------|
| "帮我写一个 flow" / "自动化 xxx 流程" | → [写 flow](#write) |
| "用 flowcast 做 xxx" / "跑这个任务" | → [运行任务](#run) |
| "flow 报错了" / "怎么续跑" | → [排查失败](#debug) |
| "配置质量门" / "设置 model" | → [配置项目](#config) |
| "校验 task.name / tag 路径字符" / "防 .. 穿越" | → [实用工具](#utilities) |
| "事件 schema 是什么" / "loop 看板" | → [Dashboard 事件字典](#utilities) |

---

## 2. 写 flow {#write}

> 详细模板和步骤见 [references/create.md](references/create.md)

**flow 文件放在项目的 `.flowcast/flows/` 目录**（`.flowx/flows/` 仍可），直接 import 包名：

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

---

## 6. 实用工具与内部 surface {#utilities}

> 完整 API 见 [docs-site/api/utilities](/api/utilities)

**安全相关（v0.2.0 新增）**：

- **`setHitlBackend('wecom', cfg)` 路径校验**：`cfg.mcp2cli` 必须在白名单目录（`/usr/local/bin`、`/usr/bin`、`/opt/homebrew/bin` 等）；`cfg.server` 必须是 `@<ns>/<name>` 形式。防 LLM 注入任意 binary 的 RCE 信道。
- **`resolveAgent` 字段白名单**：`agents.json` 透传字段必须在白名单（`cwd` / `timeout` / `model` / `maxSteps` / `allowTools` / `extraArgs` 等）；`systemPromptFile` / `workspace` 等任意路径字段被静默丢弃。
- **`extraArgs` 元素白名单**：只允许 `claude` / `recursive` 已知安全 flag（`--model` / `--output-format` / `--max-steps` 等）；锁定型执行器（`cursor` / `gemini` / `codex` / `agy`）拒绝任何 flag。
- **`assertSafeIdent(name)`** 校验任务/资源标识符（`task.name` / `failure-context` 的 `tag`）。拒绝 `..` / `/` / `\` / `.` 开头等路径穿越字符。

**Loop 协作窄接口（v0.2.0）**：

- `cp.setLoopState({verdict, status, turns, reason})` 部分更新 loop 状态字段（自动 flush）
- `cp.getLoopState()` 读 loop 状态
- `cp.countCompletedTurns()` 扫已完成 `turn-N` 形式步骤数
- `cp.setExpectMaxMs(ms)` 声明期望最大时长（dashboard 自适应僵尸阈值用）

**Dashboard 事件 schema 字典**：

`cp.event(type, data)` 任意 type + object，但只有登记的会被 `summarizeEvents` 识别。完整字典见 [docs-site/api/dashboard#event_types](/api/dashboard#event_types)。新增 event type 务必在那里登记，否则看板静默丢。

**`flowcast/internal` 入口**（无稳定性承诺，仅供测试 / 工具脚本）：

```js
// ❌ 不要这样用（主入口不暴露）
import { clearFlowcastDirCache } from 'flowcast'

// ✅ 测试 / 工具脚本可以这样用（内部入口）
import { sweepStaleTmp, clearFlowcastDirCache, AGENT_COOLDOWN_BASE_MS } from 'flowcast/internal'
```
