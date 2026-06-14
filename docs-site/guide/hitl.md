# HITL 人工介入

HITL（Human-in-the-Loop）让 flow 在关键节点**阻塞等人工决策**或**单向通知**。flowcast 的 HITL 后端是**可插拔**的：终端、企业微信，或你自己注入的任意实现。

## 两个原语

```js
import { waitForInput, notify, setHitlBackend } from 'flowcast'

await notify('分析完成，开始生成 PR')          // 单向通知，不等待
const answer = await waitForInput('确认要合并吗？(y/n)')   // 阻塞等人工输入
```

- `notify(message)` — 单向通知人类，不阻塞。后端无 `notify` 时回退终端打印。
- `waitForInput(prompt)` — 阻塞等人类输入，返回输入文本。

## 选择后端

flow 启动时用 `setHitlBackend` 选定后端：

```js
setHitlBackend('terminal')                          // 默认：readline 终端输入
setHitlBackend('wecom', { projectName: 'flowcast' })   // 企业微信
setHitlBackend(customBackendObject)                 // 直接注入自定义对象
```

一个 HITL 后端就是一个对象：

```js
{
  waitForInput(prompt) { /* → Promise<string> */ },
  notify(message)      { /* → Promise<void> */ },
}
```

### terminal 后端

默认后端。用 Node 的 `readline` 在终端阻塞读取一行输入。适合本地交互式开发。

### wecom（企业微信）后端

把消息发到企微群 / 个人会话，等用户 `@机器人` 回复。适合**长任务通知**、**异步决策**、**跨时区协作**。

两种接入方式：

1. **注入 sender**（宿主集成 / 测试）：

```js
setHitlBackend('wecom', {
  projectName: 'flowcast',
  chatId: 'wrk...',
  async sendAndWait(prompt, ctx) { /* 你的发送+等待实现 */ },
  async send(message, ctx)       { /* 你的单向发送实现 */ },
})
```

2. **mcp2cli**（默认）：通过 `mcp2cli` 调用 wecom-hil MCP 的 `send_and_wait_reply` / `send_message_only`：

```js
setHitlBackend('wecom', {
  projectName: 'flowcast',
  mcp2cli: 'mcp2cli',     // 可执行名
  server: '@wecom-hil',   // MCP server 标识
})
```

`waitForInput` 会调 `send_and_wait_reply`（超时上限 24h），从返回 JSON 取 `replies[0].content`；`notify` 调 `send_message_only`（失败仅告警、不影响主流程）。

## 在 flow 里用 `--hitl` 切换

按 [FLOW_API](/api/) 约定，生成的 flow 接受 `--hitl` 参数（`terminal` 默认 / `wecom`）和 `--project-name`，骨架会自动调用 `setHitlBackend`：

```bash
flowcast run ./flows/my-flow.js --hitl wecom --project-name flowcast
```

## 与 Checkpoint 配合

HITL 常和 `cp.pause` 配合做"暂停 → 人工确认 → 续跑"：

```js
const verdict = await cp.step('await-review', () =>
  waitForInput('PR 已生成，确认无误回 y，否则描述要改的地方'))

if (verdict.trim().toLowerCase() !== 'y') {
  await cp.step('revise', () => runAgent(`按反馈修改：${verdict}`, { cli: 'claude' }))
}
```
