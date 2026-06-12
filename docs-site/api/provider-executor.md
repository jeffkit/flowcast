# API · Provider / Executor

声明式配置加载、provider 解析，以及执行器能力分层与 agent profile 绑定。

```js
import {
  interpolateEnv, loadProviders, resolveProvider, loadMergedConfig, basenamesFor,
  EXECUTORS, getExecutor, loadAgents, resolveAgent,
} from '@force-lab/flowx'
```

## Provider

### loadProviders({ repo?, dirs? })

加载并合并多层 provider 配置：`~/.flowx` → `<repo>/.flowx`（后者覆盖前者）。返回 `Record<name, providerCfg>`。

### resolveProvider(name, providers, env?)

把命名 provider 解析为通用 bundle `{ name, type, apiBase, model, apiKey }`。`name` 为空返回 `null`；未知 name 抛错（带已定义列表提示）。`apiBase` / `model` / `apiKey` 里的 `${VAR}` 用 `env`（默认 `process.env`）插值。兼容旧字段 `base` → `apiBase`、`keyEnv` → `apiKey`。

### interpolateEnv(template, env?)

`${VAR}` 运行时插值：

- 仅识别 `${IDENT}`（`[A-Za-z_][A-Za-z0-9_]*`）。
- `$$` → 字面 `$`。
- **缺失变量 fail-fast**（区分显式空串与未定义）。
- 不支持默认值语法、不递归。

### loadMergedConfig(basenames, { repo?, dirs?, key? })

通用多层配置加载器（`loadProviders` / `loadAgents` 的底座）。`key` 是顶层 section（如 `'providers'` / `'agents'`），文件可写 `{key:{...}}` 或裸 `{...}`。

### basenamesFor(stem)

返回候选文件名（按优先级）：`['<stem>.json', '.yaml', '.yml', '.js', '.mjs']`。

## Executor

### EXECUTORS

执行器注册表。每项 `{ run, applyProvider? }`——**有 `applyProvider` 即接受外部 provider**（BYO-LLM），没有则锁定型：

| 执行器 | 类型 |
|--------|------|
| `recursive` / `aider` / `claude` | BYO-LLM（可注入 provider） |
| `cursor` / `agent` / `gemini` / `codex` / `agy` | 锁定型（自管鉴权/路由） |

### getExecutor(name)

返回 `{ name, run, applyProvider, acceptsProvider }`；未注册抛错。`acceptsProvider` 由 `applyProvider` 是否存在派生（单一事实来源）。

### loadAgents({ repo?, dirs? })

加载并合并多层 agent profile 配置。返回 `Record<name, agentCfg>`。

### resolveAgent(name, agents, { providers?, env? })

把具名 agent profile 解析为 `{ executor, run, opts }`：

- profile 缺失 → 抛错（dry-run 下给假 runner 让 flow 跑下去）。
- 缺 `executor` 字段 → 抛错。
- profile 带 `provider` 但执行器是锁定型 → **fail-fast**（恒做，dry-run 也校验）。
- 透传业务无关选项（`maxSteps` / `cwd` / `timeout` / `model` …）到 `opts`。
- 注入 provider 时，profile 显式选项**优先**于翻译器产出（如 profile 写了 `model` 不被覆盖）。

```js
const [agents, providers] = await Promise.all([loadAgents({ repo }), loadProviders({ repo })])
const a = resolveAgent('recursive-deepseek', agents, { providers })
await a.run('实现 X', { cwd: repo, ...a.opts })
```

指南见 [配置分层](/guide/configuration)。
