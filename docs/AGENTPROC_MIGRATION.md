# AgentProc 迁移说明（v0.6）

> flowcast v0.6 把 executor 子系统的 CLI 适配层从手写 `adapters.js` 迁移到
> [AgentProc](https://github.com/jeffkit/agentproc) v0.10.0 SDK 的 in-process executor。
> 本文档说明**为什么迁移、改了什么、用户能看到什么、不兼容的边界在哪**。

## TL;DR

- **删** `adapters.js`(307 行手写 per-CLI 解析)
- **新增** `executor/agentproc-adapter.js`(声明式翻译层)+ `executor/recursive-extras.js`(agentproc SDK 不收录的特殊处理)
- **白嫖** AgentProc v0.10.0 的 12 个 executor + 协议级特性(`usage` 透传 / `env_allowlist` / mid-turn permission)
- **多 5 个 CLI** 零成本接入(pi / opencode / kimi-code / deepseek / qwen-code)
- **零破坏性变更**:`runAgent` / `runAgentChain` / `registerExecutor` / `resolveAgent` / `EXECUTORS` / `setWorkdir` / `setAgentEventSink` / 所有 env var / 所有 EVENT 常量均保持兼容

## 为什么迁移

v0.5.2 的 executor 子系统维护 7 个 CLI adapter(`claude` / `cursor` / `gemini` / `codex` / `aider` / `recursive` / `agy`),每个 adapter 各自写:

- `spawnCapture(...)` 调用 CLI + 超时/SIGTERM 处理
- `JSON.parse(stdout)` / 临时文件读 / raw trim 三种解析策略
- `makeAgentResult(text, {cli, model, inputTokens, outputTokens})` 字段填充
- provider env 翻译(`ANTHROPIC_*` / `OPENAI_*` / `RECURSIVE_*`)

合并成本 ~300 行,有几个**已知缺陷**:

1. **session 续接语义碎片化**:`claude` 用 `--resume <sid>`,`recursive` 用 transcript 文件,其他 CLI 没有会话概念。需要 session_id 时只能从 stdout 解析 claude 的字段,其他 CLI 默认丢失
2. **usage 统计不完整**:只有 `inputTokens` / `outputTokens`,Claude 的 cache hit / reasoning tokens 完全丢失,**成本核算误差可达一个数量级**
3. **`env_allowlist` 缺失**:profile.env 一旦塞了 `${VAR}` 表达式,会展开任何 env 变量;agentproc v0.10.0 的 `env_allowlist` 强制声明读取的 env 列表
4. **per-CLI 解析逻辑漂移**:adapters.js 与 agentproc hub bridge 各自独立维护,bug 修两处(formatter、中断恢复),已出现过 SHA 索引与 agentproc 不一致的情况

AgentProc v0.10.0 由同一作者维护,提供统一的 in-process executor + 协议级 `usage` 字段 + `env_allowlist`,直接消费它是最干净的出路。

## 改了什么

### 删除:`adapters.js`

307 行的手写 per-CLI 解析代码全部消失。删除前:

```
adapters.js
├── claudeProviderEnv, recursiveProviderEnv  // provider env 翻译器
├── claude, cursor, gemini, codex, aider, recursive, agy  // 7 个 adapter
├── CLAUDE_DEFAULT_TIMEOUT, ...  // 7 个 timeout 常量
├── setAgentEventSink, emitAgentEvent  // 观测事件 sink
└── helpers used internally: makeEvent
```

### 新增:`executor/agentproc-adapter.js`

~258 行的**纯翻译层**,不引入任何 per-CLI 解析逻辑。核心 export:

| 名字 | 作用 |
|------|------|
| `CLI_TO_EXECUTOR` | flowcast CLI 名(`claude`) → agentproc executor 名(`claude-code`)映射表 |
| `KNOWN_EXECUTORS` | agentproc SDK 当前支持的 executor 名列表(运行时查) |
| `cliToExecutorName(cli)` | CLI 名 → executor 名,未知抛 `ConfigError`,`recursive` 返回 `null`(特殊路径) |
| `buildAgentProcProfile(ctx)` | flowcast ctx → agentproc profile 对象(`{executor, env, env_allowlist, cwd, timeout_secs, streaming, permission}`) |
| `buildAgentProcOptions(prompt, opts)` | flowcast opts → agentproc `RunOptions`(`{message, sessionId, onPartial, onError, ...}`) |
| `resultToAgentResult(run, cli, executor)` | agentproc `RunResult` → flowcast `makeAgentResult`(翻译错误为 `FlowcastError` / `TimeoutError` / `SpawnError`) |
| `runViaAgentProc(prompt, ctx, opts)` | 主入口:对 agentproc 收录的 CLI 调 `agentproc.run()`,对 `recursive` 返回 `{__flowcastPath: true}` sentinel 让调用方走自有路径 |

### 新增:`executor/recursive-extras.js`

85 行,处理 **agentproc SDK 不收录的 `recursive`**(它的 bridge 有 session-dir 状态管理,不符合 agentproc 通用 `buildArgs/parseEvent` 模式):

| 名字 | 作用 |
|------|------|
| `resolveRecursiveBin(cwd)` | 解析 recursive 二进制路径(`target/release/recursive` / `target/debug/recursive` / PATH) |
| `deriveRecursiveMeta(runResult, opts)` | 从 RunResult.reply 解析 `[done after N steps] reason: <X>` → `_meta.finishReason` / `budgetExceeded` / `panicked` / `transcriptMessages` |
| `maybeThrowRecursiveCritical(runResult, opts)` | 当 `throwOnCritical=true` 且 panicked/budgetExceeded/非零退出时抛 `FlowcastError('RECURSIVE_FAIL')` |

### `provider.js` 扩展

把 provider env 翻译器从 `adapters.js` 搬过来,并新增组合函数:

```js
claudeProviderEnv({apiBase, apiKey})    // → {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN}
recursiveProviderEnv({type, apiBase, model, apiKey, maxSteps})  // → {RECURSIVE_*}
aiderProviderEnv({apiBase, apiKey})     // → {OPENAI_API_BASE, OPENAI_API_KEY}
applyProviderToProfile(profile, cli, bundle)  // 把 bundle 写进 agentproc profile.env
providerEnvTranslator(cli)              // 取对应 CLI 的翻译器
```

### `executor.js` 重写

保持所有公共 API 不变,**只换内部机制**:

| 公共 API | 现状 |
|---------|------|
| `runAgent(prompt, opts)` | ✓ 不变,内部委托给 `runViaAgentProc` |
| `runAgentChain(prompt, chain, opts)` | ✓ 不变 |
| `registerExecutor(name, run, {applyProvider})` | ✓ 不变,旧签名 + `acceptsProvider` 双兼容 |
| `resolveAgent(name, agents, ctx)` | ✓ 不变 |
| `EXECUTORS` | 内部含义变:从 `{cli: {run, applyProvider}}` 变成 `{cli: {executorName, acceptsProvider}}`,executorName 为 `null` 时走 flowcast 自有路径(recursive) |
| `getExecutor(name)` | ✓ 返回字段加 `executorName` + `applyProvider`(向后兼容旧用法) |
| `setWorkdir(dir)` | ✓ 不变 |
| `setAgentEventSink(fn)` / `emitAgentEvent(e)` | ✓ 不变(从 `adapters.js` 搬到 `executor.js`) |

## 用户能看到什么

### 新增 CLI 覆盖

flowcast 现在**开箱支持 14 个 CLI**(无需写任何 adapter):

| flowcast CLI 名 | agentproc executor | 来源 |
|----------------|-------------------|------|
| `claude` | `claude-code` | hub 官方 |
| `cursor` / `agent` | `cursor` | hub 官方 |
| `gemini` | `gemini-cli` | hub 官方 |
| `codex` | `codex` | hub 官方 |
| `agy` | `agy` | hub 社区 |
| `aider` | `aider` | hub 社区 |
| `pi` | `pi` | hub 社区(**新增**) |
| `opencode` | `opencode` | hub 社区(**新增**) |
| `kimi-code` | `kimi-code` | hub 社区(**新增**) |
| `deepseek` | `deepseek` | hub 社区(**新增**) |
| `qwen-code` | `qwen-code` | hub 社区(**新增**) |
| `codebuddy` | `codebuddy` | hub 官方(**新增**) |
| `recursive` | (无,flowcast 自有) | hub 社区,agentproc SDK 不收录 |

### `usage` 字段从二进制变成结构化数据

**v0.5 之前**:`_meta` 只有 `inputTokens` / `outputTokens`(只有部分 CLI 上报,recursive 是手写解析 `[done after N]`)

**v0.6**:agentproc 透明透传 CLI 上报的所有 usage 字段。`_meta.usage` 是完整对象:

```js
{
  input_tokens: 1234,
  output_tokens: 567,
  cache_read_input_tokens: 890,     // Claude cache hit
  cache_creation_input_tokens: 12,  // Claude cache write
  reasoning_tokens: 24,             // o1 / Claude thinking
  duration_ms: 4523,                // turn 内耗时(不含 spawn)
  cost_usd: 0.023,                  // 可选,SDK 可估算
}
```

下游 `checkpoint.pickAgentMeta` 自动把 `input_tokens` / `output_tokens` 提到 `_meta.inputTokens` / `_meta.outputTokens` 一级,保持向后兼容。

### session 续接

**v0.5 之前**:只有 `claude`(--resume 隐式 args)和 `recursive`(transcript 文件续接),其他 CLI 没会话概念。

**v0.6**:agentproc 协议级 `session_id` 字段,所有能 emit `session_id` 的 CLI 自动续接。`runAgent` 加了 `sessionId` opts:

```js
const r1 = await runAgent('tell me a joke', { cli: 'agy' })
const sid = agentMeta(r1).sessionId  // 当 CLI 支持时
const r2 = await runAgent('now laugh at it', { cli: 'agy', sessionId: sid })
```

`runStructured(runner, prompt, {schema})` 路径也走 agentproc(因为 `runner(prompt)` 返回 `String & {_meta}`,agentproc 调用结果兼容)。

### `env_allowlist` 安全护栏

`profile.env` 在 v0.5 时 `${VAR}` 表达式会**展开任何 env 变量**(包括 `AWS_SECRET_ACCESS_KEY` 等敏感变量)。v0.6 把 env 组合交给 agentproc,agentproc 提供 `env_allowlist`(可选白名单),**未声明的变量被 agentproc 静默展开为空字符串 + stderr warning**。

v0.6 我们仍未在 profile schema 里强制 `env_allowlist`,但**未来计划**让 `loadAgents` 自动从 `agents.json` 的 env 字段里推断并注入 `env_allowlist`(见 [未决问题](#未决问题))。

### mid-turn permission 流模式(可选)

agentproc v0.10.0 支持 `permission: true` profile 字段,允许 mid-turn tool 调用需要权限确认(用 NDJSON `permission_request` ↔ `permission_response`)。v0.6 flowcast **默认关闭**(`profile.permission = false`),保留给未来 IM 桥接场景用。本地 HITL 走 `hitl.js`。

## 不兼容 / 破坏性变更

### 公开 API 破坏(已修复)

1. **`registerExecutor(name, run, {applyProvider})` 旧签名**:原 `applyProvider` 是 provider bundle → `{env?, model?}` 翻译函数;新 `acceptsProvider` 是布尔字段。**保留旧签名**(把 function-presence 自动 derive 成 `acceptsProvider=true`),新代码才推荐用布尔。

2. **`runAgent` 接受 `cli: 'recursive'`**:v0.5.2 throwOnCritical 默认值从 false 改成 true(P1-A3 fix);v0.6 沿用这个行为。如果需要旧行为,显式 `throwOnCritical: false`。

### 输出 `_meta` 字段差异

| 字段 | v0.5.2 | v0.6 |
|------|-------|------|
| `cli` | ✓ | ✓ |
| `model` | ✓ | ✓ |
| `inputTokens` / `outputTokens` | ✓ | ✓(从 `usage` 字段投影) |
| `executor` | ✗ | **新增**(agentproc executor 名) |
| `sessionId` | ✗(隐式) | **新增**(agentproc 上游字段统一提取) |
| `usage` | ✗ | **新增**(完整对象,含 cache / reasoning / duration / cost) |
| `exitCode` | ✓ | ✓ |
| `timedOut` | ✓ | ✓ |
| `spawnError` | ✓(recursive) | ✓(所有 CLI) |

### agents.json 配置文件

`agents.json` schema **完全不变**。示例:

```json
{
  "agents": {
    "claude-dev": {
      "executor": "claude",
      "provider": "deepseek",
      "maxSteps": 50
    }
  }
}
```

仍合法。`profile.provider` 还是经 `claudeProviderEnv` 翻译为 `ANTHROPIC_*`,但同时通过 `applyProviderToProfile` 写入 agentproc profile.env,确保 agentproc 路径不走丢。

### 自定义 executor 用户

`registerExecutor('my-cli', async (prompt, opts) => ...)` 不依赖 agentproc,**完全不变**。但注意:

- 自定义 executor 的 `run` 函数应返回 `String & {_meta}`(与旧契约相同)
- 如果想接 agentproc 协议级特性(`usage` 透传 / `session_id`),需要把代码改成调 `runViaAgentProc`(参考 README)

## 验证方式

### 单元测试

```bash
npm test                          # 376/376 通过
node --test test/agentproc-adapter.test.js  # 18 个新加的翻译层测试
node --test test/executor.test.js          # 39 个保留的 executor 行为测试
node --test test/agent.test.js             # 28 个保留的 chain / event / hitl / provider 测试
```

### Dry-run 烟测

```bash
FLOWCAST_DRY_RUN=1 node -e "
import('./index.js').then(async m => {
  for (const cli of ['claude', 'cursor', 'agy', 'codex', 'gemini', 'aider', 'pi', 'opencode']) {
    const r = await m.runAgent('hi', { cli, cwd: '/tmp' });
    console.log(cli.padEnd(12), '->', String(r));
  }
});
"
```

### 真实 CLI 烟测

需要已安装 CLI + 有效 API key:

```bash
node -e "
import('./index.js').then(async m => {
  const r = await m.runAgent('say hi in 3 words', { cli: 'claude', cwd: process.cwd() });
  console.log('reply:', String(r));
  console.log('sessionId:', m.agentMeta(r).sessionId);
  console.log('usage:', JSON.stringify(m.agentMeta(r).usage));
});
"
```

预期看到:

- `reply:` 真实模型回复
- `sessionId:` claude 二进制 emit 的 `system/init` event 中 `session_id` 字段(由 agentproc extract)
- `usage:` 完整 object `{input_tokens, output_tokens, cache_read_input_tokens, ...}`

### Schema 模式

```bash
node -e "
import('./index.js').then(async m => {
  const r = await m.runAgent('give me JSON {word: string}', {
    cli: 'agy', cwd: process.cwd(),
    schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  });
  console.log('parsed:', JSON.parse(String(r)));
});
"
```

预期看到 `{"word": "..."}` —— `runStructured` 仍工作,因 `runner(prompt)` 返回 `String & {_meta}`,agentproc 调用结果兼容。

## 回滚

如果生产环境遇到不可接受的回归:

```bash
git revert HEAD  # 假设迁移在一个 commit 里
npm install agentproc@^0.10.0  # 保留依赖,因为 v0.5.2 不需要
```

或者**更干净的回滚**:

1. `git checkout v0.5.2 -- adapters.js executor.js provider.js package.json`
2. 把 `executor/` 目录和 `test/agentproc-adapter.test.js` 删掉
3. `npm uninstall agentproc`(移除 file: 依赖)
4. 跑 `npm test`,应恢复到 v0.5.2 测试集

不影响 `runAgent` / `runAgentChain` 公共 API(它们没变),只影响内部实现 + 新增的 5 个 CLI 覆盖。

## 未决问题

1. **`env_allowlist` 自动化**:profile env 字段目前不强制声明 allowlist,建议下个版本在 `loadAgents` 自动从 env 字段里推断 — 这样可以保护环境
2. **recursive 进入 agentproc SDK EXECUTORS 表**:现在的 special-case 路径很丑;如果未来 agentproc 把 session-dir 状态管理抽象成 `Executor.makeHandlers()` 工厂,我们能直接复用
3. **`runProfile` agent name → executor 解析**:L3 codegen 现在生成 `runProfile(agentName, ...)` 调用,内部 `resolveAgent` 通过 `executor` 字段找到对应 adapter。后续可以让 `runProfile` 接受 agentproc profile YAML 作为替代输入,但需要先把 generated flow schema 拓展
4. **dry-run 增广**:现在 dry-run 给所有 CLI 返回相同 stub;agentproc SDK 的 fake executors 应该可以驱动真实 dry-run 流(见 [AgentProc issue #?](#))

## 参考

- AgentProc 规范:<https://agentproc.dev/> / <https://github.com/jeffkit/agentproc/blob/main/spec/protocol.md>
- AgentProc v0.10.0 变更日志:<https://github.com/jeffkit/agentproc/blob/v0.10.0/CHANGELOG.md>
- flowcast v0.6 提交记录:`git log --oneline -- adapters.js executor.js executor/`
- 在 agentproc 仓提的三个 issue:#1 / #2 / #3