# 落地方案：ACP Executor（`acp` 执行器类型）

> 状态：草案 v1，待讨论拍板
> 提出：B仔  |  日期：2026-07-07
> 关联：`executor.js` / `adapters.js` / `helpers.js` / `hitl.js`；`agentproc` 对比见对话记录

---

## 0. TL;DR（先给结论）

新增一个**泛型 `acp` executor 类型**，用官方 `@agentclientprotocol/sdk`（v1.2.0）作为 client 端，驱动任何**原生讲 ACP 的 agent 子进程**（claude / codex / gemini 当前都支持）。它**不替换**现有 7 个原生 adapter，而是与它们并列，吃"正经 agent 服务"这一类目标。

**核心价值三点**：
1. `_meta` 从「逐 CLI 手写正则/JSON 解析」变成「协议级结构化白送」——主要是 `usage_update`（session 级累计 `used`/`size`/`cost`）、`stopReason`、`agent_message_chunk` 流式、`tool_call` 遥测。
2. `session/request_permission`（agent → host 反向请求）**天然映射 flowx 已有的 HITL 子系统**（terminal/wecom），零新基础设施。
3. `session/resume` / `session/close` 已稳定，统一了现在各 adapter 各写各的续接逻辑。

**一个必须 management 的预期代价**（诚实标注）：per-turn 的 input/output token **拆分**在 ACP 里还是 **DRAFT**（End-Turn Token Usage RFD 未稳定）。所以短期 ACP executor 在 token 维度**比原生 recursive/claude adapter 少**——只能拿到 session 累计 `used`，拿不到 per-turn input/output 拆分。详见 §4。

---

## 1. 背景与痛点

现状：每个 adapter 是 `async (prompt, opts) => makeAgentResult(text, meta)`，私有 `_meta` 逐 CLI 手搓：

| adapter | `_meta` 内容 | 提取方式 |
|---|---|---|
| claude | model + inputTokens + outputTokens | `JSON.parse(stdout)` 取 `item.model` / `usage.*` |
| cursor | inputTokens + outputTokens（无 model） | `JSON.parse` 取 `data.usage.*` |
| gemini/codex/agy/aider | 仅 `model`（CLI 不报 token） | 把传入 model 原样塞回 |
| recursive | exitCode/timedOut/budgetExceeded/finishReason/panicked/transcriptMessages | 正则抠文本 + 读退出码 + 读外部 transcript 文件 |

代价：每加一个 CLI 要重写一套解析；token 维度各 CLI 行为不一致；recursive 的 `panicked`/`BudgetExceeded` 检测是 bespoke 私有逻辑。

ACP 当下的真实能力（已核对官方协议文档 + SDK 1.2.0）：

| ACP 消息 | 方向 | 是否稳定 | flowx 用途 |
|---|---|---|---|
| `session/new` / `session/load` | C→A | 稳定 | 建会话，拿 sessionId |
| `session/prompt` | C→A | 稳定 | 发用户消息，响应带 `stopReason` |
| `session/update`（含 `agent_message_chunk` / `tool_call` / `tool_call_update` / `usage_update` / `plan`） | A→C | 稳定 | 流式文本 + 工具遥测 + **session 级成本** |
| `session/request_permission` | A→C | 稳定 | **映射到 HITL** |
| `session/cancel` | C→A | 稳定 | 超时/中断 |
| `session/close` | C→A | **已稳定**（早先文档称无，现已补） | 资源清理 |
| `session/resume` | C→A | **已稳定** | 续接会话 |
| `usage`（per-turn input/output token） | 在 `PromptResponse` 或 v2 `state_update` | **DRAFT，未稳定** | ⚠️ 短期不可靠 |

transport：本地 agent 作为 client 子进程，stdio over JSON-RPC 2.0。SDK 用 `client({ name })` 注册 `requestPermission(...)` / `sessionUpdate(...)` handler，再 `connectWith(stream, async ctx => {...})`。

---

## 2. 架构 shift 与关键决策（开放问题 ①）

flowx 现状：**无状态**——每次 `run(prompt)` 一次性 spawn，adapter 是 `async (prompt, opts) => result`。

ACP：**有状态**——agent 是长驻子进程，一个 session 跨多个 prompt turn。

两种落法：

### 方案 A — 无状态适配（**MVP 推荐**）
acp adapter 每次 `run(prompt, opts)` 内部：`new AcpSession(...) → session/new → session/prompt → 收集 update → session/close → 返回 result`。
- ✅ 与现有 `runAgent` / `runAgentChain` / 白名单 / dry-run 完全兼容，改动面最小。
- ❌ 每次 run 是独立 session，**无跨 run 记忆**（丧失 ACP 多轮会话优势）。

### 方案 B — 会话句柄（演进方向）
executor 返回一个 `AcpSession` 句柄，编排层持有，多次 `prompt()` 复用同一 session。
- ✅ 真正发挥 ACP 设计初衷；fanOut 时每个子任务一个独立 ACP session（独立子进程），多轮编排更干净。
- ❌ 需要改 `runAgent` 接口（从一元函数 → 句柄式），与 `runAgentChain` 的「一次性 spec」模型冲突，架构 shift 大。

**建议**：MVP 走 **A**（先跑通、先拿到结构化 `_meta` + HITL 映射），B 作为后续演进（配合 orchestrateMulti 的并发子任务）。

---

## 3. 核心抽象：`AcpSession` 类（骨架）

```js
// acp.js — ACP executor（client 角色，驱动 ACP agent 子进程）
import { client } from '@agentclientprotocol/sdk'
import { spawn } from 'child_process'
import { makeAgentResult } from './helpers.js'
import { FlowcastError } from './errors.js'
import { getHitlBackend } from './hitl.js'

export class AcpSession {
  constructor({ bin, cwd, model, env = {}, hitlBackend, timeout = 300_000 }) {
    this.bin = bin            // agent 二进制（PATH 名或白名单目录绝对路径）
    this.cwd = cwd
    this.model = model
    this.env = env
    this.hitl = hitlBackend ?? getHitlBackend()
    this.timeout = timeout
    this._child = null
    this._ctx = null
  }

  async open() {
    // spawn agent binary（stdio），用 SDK 提供的 stdio transport 接入 connectWith
    this._child = spawn(this.bin, [], { cwd: this.cwd, env: { ...process.env, ...this.env } })
    const stream = /* SDK stdio transport from child.stdin/stdout */ null
    const c = client({ name: 'flowcast' })
    c.sessionUpdate((ctx, params) => this._onUpdate(params))   // 累积文本/_meta
    c.requestPermission((ctx, params) => this._onPermission(params)) // → HITL
    this._ctx = await c.connectWith(stream, async (ctx) => {
      const { sessionId } = await ctx.session.new({ /* model 等 config */ })
      this._sessionId = sessionId
    })
  }

  async prompt(promptText, { onData } = {}) {
    this._onData = onData
    const res = await this._ctx.session.prompt({ sessionId: this._sessionId, prompt: [{ type: 'text', text: promptText }] })
    const meta = { ...this._accumulatedMeta, stopReason: res.stopReason, sessionId: this._sessionId }
    return makeAgentResult(this._text, meta)
  }

  _onUpdate({ update }) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this._text += update.content.text
        this._onData?.(update.content.text)   // 流式 → onData
        break
      case 'usage_update':
        this._accumulatedMeta.contextUsed = update.used
        this._accumulatedMeta.contextSize = update.size
        if (update.cost) this._accumulatedMeta.cost = update.cost  // {amount, currency}
        break
      case 'tool_call':
      case 'tool_call_update':
        ;(this._accumulatedMeta.toolCalls ??= []).push(update)
        break
    }
  }

  async _onPermission(params) {
    // 把 ACP 权限请求转成 flowx HITL（见 §6）
    if (!this.hitl) throw new FlowcastError('ACP agent 请求权限但 HITL 后端未配置')
    const answer = await this.hitl.waitForInput(renderPermissionPrompt(params))
    return parseApproval(answer, params)   // → { behavior: 'allow'|'deny', updatedArgs? }
  }

  async cancel() { await this._ctx.session.cancel({ sessionId: this._sessionId }) }
  async close() { await this._ctx.session.close({ sessionId: this._sessionId }); this._child.kill() }
}

// executor.js 注册
export async function acp(prompt, opts) {
  const s = new AcpSession(opts)
  try {
    await s.open()
    const r = await s.prompt(prompt, { onData: opts.onData })
    return r
  } finally {
    await s.close().catch(() => {})
  }
}
```

> ⚠️ `connectWith` 的 stream 参数具体形态（stdio transport helper 名）实现时需核对 SDK 类型定义；上面用占位 `/* SDK stdio transport */` 标注。

---

## 4. `_meta` 映射（字段级，含 DRAFT 标注）

| flowx `_meta` 字段 | ACP 来源 | 状态 |
|---|---|---|
| `model` | `session/new` 协商 / `initialize` capabilities 回传 | 稳定（若 agent 报 model） |
| `exitCode` | 子进程退出码 | 稳定 |
| `timedOut` | 超时 → `session/cancel` | 稳定 |
| `stopReason` | `PromptResponse.stopReason`（`end_turn`/`max_tokens`/`refusal`/`cancelled`…） | 稳定 |
| `sessionId` | `session/new` 返回 | 稳定（resume 用） |
| `contextUsed` / `contextSize` | `usage_update.used` / `usage_update.size` | **稳定**（session 级累计） |
| `cost.amount` / `cost.currency` | `usage_update.cost.{amount,currency}`（ISO 4217） | **稳定**（session 级累计） |
| `toolCalls` | `tool_call` / `tool_call_update` 累积 | 稳定 |
| `inputTokens` / `outputTokens` | `PromptResponse.usage.{inputTokens,outputTokens}` | ⚠️ **DRAFT，未稳定** |
| `panicked` / `budgetExceeded` | 无直接对应；`max_tokens` stopReason 近似 | 需映射/退化 |

**关键诚实点**：当下 ACP 稳定提供的成本是 **session 级累计**（`used` / `size` / `cost`），而 flowx 现在 recursive/claude adapter 能拿到的 **per-turn input/output 拆分**在 ACP 里还是 draft。所以：

- **短期 ACP executor 在 token 维度比原生 adapter 少**（只有 session 累计 used，无 per-turn 拆分）。
- recursive 专属的 `panicked` / `budgetExceeded` 检测，**ACP 给不了对等信号**，需靠 `max_tokens` stopReason 近似或退化。
- **结论**：ACP 适合迁移「本就不报 per-turn token」的 CLI（gemini/codex/agy 原生就没 token），不适合急着替换 recursive/claude 这种深度依赖 per-turn token + panic 检测的 adapter。

---

## 5. 与现有契约的衔接

- **注册**：`registerExecutor('acp', acp)`，或直接在 `EXECUTORS` 加 `acp: { run: acp }`。
- **agents.json**：新增 `executor: 'acp'` + `bin`（agent 二进制）+ `model`（session/new 用）+ 现有 `SAFE_OPTS_KEYS` 字段。
- **白名单扩展**：`SAFE_OPTS_KEYS` 增加 `'bin'`，让 profile 能配 binary。但 `bin` 是执行任意二进制——必须走 PATH 解析或绝对路径白名单目录（见 §7），**不允许 profile 指定任意绝对路径 bin**（防配置注入执行恶意二进制）。
- **resolveAgent**：`bin` 经白名单校验；`model` 透传；provider 默认不接受（`acceptsProvider: false`，ACP agent 自管鉴权），除非是 BYO-LLM 型（见开放问题 ⑦）。
- **runAgent**：`cli: 'acp'` 走 `EXECUTORS['acp'].run`；`onData` 流式 → `agent_message_chunk` 回调。
- **runAgentChain**：`acp` 作为一个 cli 名加入 chain；限流 key 用 `cli='acp' + model`；ACP 特定错误（超时 / stopReason=cancelled / agent 报 rate-limit）翻译为 `FlowcastError` 且 `isProviderRetryable` 识别。
- **dry-run**：`makeFakeRun` 已支持 `acp`，无需改动。

---

## 6. HITL 映射（亮点，开放问题 ②）

ACP `session/request_permission`（A→C）→ client 的 `requestPermission` handler → 调用 `getHitlBackend().waitForInput(renderPermissionPrompt(p))` → 把人类输入映射成 ACP 的 allow/deny + 可选 `updatedArgs`。

**问题**：flowx HITL `waitForInput` 返回**自由文本**，而 ACP 要结构化 `allow`/`deny` 决策。两种解法：
- **(a)** 适配层用 "yes/no" 提示 + 解析人类输入（最小改动，但语义脆弱）。
- **(b) 给 `hitl.js` 增加 `requestApproval({ title, actions }) -> { approve, reason }` 结构化语义**（更稳，且 flowx 自身 HITL 场景也用得上），ACP 适配层直接消费。

**建议**：走 (b)，把 HITL 升级成「既能 waitForInput 也能 requestApproval」的双语义后端。

这把 flowx 已有的 terminal / wecom HITL 后端**直接复用为 ACP 权限网关**，零新基础设施——这是 ACP 相对 agentproc（单向、无反向权限）的最大架构优势。

---

## 7. 安全模型（必须守住）

- 现有白名单（`SAFE_OPTS_KEYS` / `EXTRA_ARGS_WHITELIST` / `isSafePath`）继续套用，ACP executor **不绕过**。
- **新增风险：`bin` = 执行任意二进制**。约束方案（三选一，见开放问题 ④）：
  - (a) 仅 PATH 解析（`bin: 'claude'` 这种名字，走 `which`）；
  - (b) 绝对路径白名单目录（复用 `hitl.js` 的 `MCP2CLI_ALLOWED_DIRS` 思路）；
  - (c) 允许 profile 指定任意绝对路径 bin（最灵活，**最危险**，不推荐）。
- 进程边界：ACP over stdio JSON-RPC，**不抓 stdout 文本**（本来也不该），权限走协议通道而非 shell flag。
- 不引入 agentproc 那种「信任 profile 作者」的软化。

---

## 8. 依赖与文件落点

- 新增依赖：`@agentclientprotocol/sdk`（当前 1.2.0，MIT/Apache-2.0）。
- 新文件：`acp.js`（`AcpSession` + `acp` adapter）；`executor.js` 注册。
- 测试：`test/acp-executor.test.js`——用 SDK 自带 example agent 或 in-memory stream mock，验证 `session/new → prompt → update 累积 → close` 全链路与 `_meta` 映射。

---

## 9. 开放问题（供讨论拍板）

1. **MVP 走 A（无状态每次 spawn）还是 B（会话句柄复用）？** 我推荐 A。
2. **per-turn token 拆分是 DRAFT**——ACP executor 短期 `_meta` 在 token 维度比原生 adapter 少（只有 session 累计 used），是否接受这个代价？还是先只迁移「不依赖 per-turn token」的 CLI（gemini/codex/agy）？
3. **request_permission 的人类决策语义**：是否给 `hitl.js` 加 `requestApproval` 结构化接口（方案 §6-b）？
4. **`bin` 路径安全**：PATH 解析 / 绝对路径白名单目录 / 允许 profile 任意 bin —— 选哪个？
5. **是否把 claude/codex/gemini 从原生 adapter 迁到 acp**？我建议：新增 `acp` 类型、原生保留（渐进），不直接替换。
6. **长驻 session 与 `concurrency.js`（并发子任务）怎么协调**？每个 fanOut 子任务独立 ACP session（独立子进程）？
7. **provider 注入**：ACP agent 若支持 BYO-LLM（Configurable LLM Providers RFD），是否要 `acp` executor 接受 provider？短期默认不接受。
