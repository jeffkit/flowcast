# 配置文件 Schema（agents / providers / gates）

> **最后更新**：2026-07-07（v0.5.0，新增 / 整合）
>
> flowcast 的配置分三类：`agents.json` / `providers.json` / `gates.json`。
> 本文是它们的字段权威定义——单一事实来源（其他文档与示例若与此冲突以本文为准）。
> 字段是否允许出现、是否会被运行期忽略——以 `provider.js` / `executor.js` / `quality-gate.js` 的实际白名单为准。

## 配置加载与覆盖规则

所有三类配置都遵循同一加载模型（详见 `provider.js` 的 `loadMergedConfig`）：

1. **机器级**：`~/.flowcast/agents.{json,yaml,yml,js,mjs}`（向后兼容 `~/.flowx/`）
2. **项目级**：`<repo>/.flowcast/agents.{json,yaml,yml,js,mjs}`（向后兼容 `<repo>/.flowx/`）
3. **覆盖**：项目级整体覆盖机器级；同 section 内对象字段做**深合并**（deep merge），
   非对象字段（字符串/数字/数组）整体替换。
4. **缓存**：进程内 30s TTL（`FLOWCAST_CONFIG_TTL`），高频并发生成可显著降 IO。
5. **缺失变量 fail-fast**：`${VAR}` 在 provider 的 `apiKey` 等字段里运行时插值，缺变量立即抛 `ConfigError`，明文永不写进仓库。

文件后缀按顺序 `.json` → `.yaml` → `.yml` → `.js` → `.mjs`，每个目录只取第一个命中的文件。
YAML 需要 `yaml` 包（lazy import，未装则 fail-fast 提示安装）。

---

## 1. `agents.json` —— agent profile（执行器 + 调用配置）

**用途**：把「用哪个执行器 + 可选 provider + 调用选项」打包成具名 profile，flow 按名字引用。
**加载**：`loadAgents({ repo })` → `Record<profileName, profile>`
**解析**：`resolveAgent(name, agents, { providers, env })` → `{ executor, run, opts }`

### 1.1 顶层结构

```json
{
  "//": "agent profile 示例。复制到 ~/.flowcast/agents.json 或 <repo>/.flowcast/agents.json。",
  "agents": {
    "<profile-name>": { ... profile 字段 ... }
  }
}
```

也接受裸 map（省去外层 `agents` 包裹），与 `providers.json` 对称。

### 1.2 profile 字段集

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `executor` | string | ✅ | 已注册执行器名（`claude` / `cursor` / `gemini` / `codex` / `recursive` / `aider` / `agy` / 自定义）。未注册抛 `ConfigError`。 |
| `provider` | string | ❌ | 已定义 provider 名（见 `providers.json`）。**仅 BYO-LLM 执行器**接受（recursive / aider / claude）；给 cursor/gemini/codex/agy 配 provider 会 fail-fast 抛 `ConfigError`（执行器自管鉴权）。 |
| `model` | string | ❌ | 模型名。优先级：profile 显式 > provider 默认。 |
| `cwd` | string | ❌ | 工作目录（相对 repo）。 |
| `timeout` | number | ❌ | 单次 agent 调用的超时（ms）。缺省按执行器内置（recursive=30min、aider=10min、其他 5min）。 |
| `maxSteps` | number | ❌ | recursive/loop 等的最大步数（透传给底层 CLI flag）。 |
| `allowTools` | string | ❌ | recursive `--allow-tools` 的值（如 `"read,write,grep"`）。 |
| `extraArgs` | string[] | ❌ | 透传给 adapter 的额外 CLI 参数。**每个元素走 `EXTRA_ARGS_WHITELIST` 二次过滤**（防 LLM 注入 `--system-prompt-file /etc/shadow`）；白名单外的 flag 静默丢弃。 |
| `transcriptOut` | string | ❌ | recursive 专用：`--transcript-out` 路径。**必须是相对路径**且不能逃逸当前工作目录。 |
| `pricingFile` | string | ❌ | recursive 专用：`--pricing-file` 路径。同上路径安全约束。 |
| `files` | string[] | ❌ | aider 专用：要编辑的文件列表，每个元素须相对且不逃逸 cwd。 |

**白名单外字段静默丢弃**（如 `systemPromptFile`、`workspace`、`apiKey`、`apiBase` 等）——这是有意的：
防 LLM 注入任意字段。配置文件的字段集与代码级 `runAgent` 的 `RUN_AGENT_ALL_KEYS` 不完全一致，
**配置文件更严**：代码调用方允许的 `provider` / `env` / `bin` / `workspace` / `apiKey` / `apiBase`
**不接受来自配置文件**——配置文件的"可信度"低于代码。

### 1.3 EXTRA_ARGS_WHITELIST（每个执行器允许的 flag）

| 执行器 | 允许的 flag |
|--------|------------|
| `claude` | `--model` `--output-format` `--max-steps` `--allowedTools` `--system-prompt` `--dangerously-skip-permissions` |
| `recursive` | `--max-steps` `--model` `--workspace` |
| `aider` | `--model` `--edit-format` `--no-auto-commits` `--no-dirty-commits` `--read` |
| `cursor` | `--trust` `--force` `--yolo` `--dangerously-skip-permissions` |
| `gemini` | （不允许注入任何 flag——保守） |
| `codex` | （不允许） |
| `agy` | `--dangerously-skip-permissions` |

`--workspace` 等路径型 flag 额外校验：值必须相对、规范化后不以 `..` 开头。
完整实现见 `executor.js:144` 的 `sanitizeExtraArgs`。

### 1.4 完整示例

```json
{
  "agents": {
    "recursive-deepseek": {
      "executor": "recursive",
      "provider": "deepseek",
      "maxSteps": 60,
      "timeout": 1800000
    },
    "claude-sonnet": {
      "executor": "claude",
      "model": "claude-sonnet-4-6"
    },
    "cursor-default": {
      "executor": "cursor",
      "model": "auto"
    },
    "aider-haiku": {
      "executor": "aider",
      "model": "claude-haiku-4-5",
      "files": ["src/api.ts", "src/util.ts"]
    }
  }
}
```

---

## 2. `providers.json` —— provider profile（端点/模型/密钥）

**用途**：声明 LLM provider 的端点、模型、密钥。密钥用 `${ENV_VAR}` 占位，运行时从 `process.env` 插值，**明文永不写进仓库**。
**加载**：`loadProviders({ repo })` → `Record<providerName, provider>`
**解析**：`resolveProvider(name, providers, env)` → `{ type, apiBase, model, apiKey }`

### 2.1 顶层结构

```json
{
  "providers": {
    "<provider-name>": {
      "type": "openai",
      "apiBase": "https://api.deepseek.com/v1",
      "model": "deepseek-v4-pro",
      "apiKey": "${DEEPSEEK_API_KEY}"
    }
  }
}
```

### 2.2 provider 字段集

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | ❌ | 协议族：`openai` \| `anthropic`。当前主要给 provider 自身与未来扩展使用；递归翻译器按需读取。 |
| `apiBase` / `base` | string | ❌ | 端点 URL（如 `https://api.deepseek.com/v1`）。`base` 是历史别名，向后兼容。 |
| `model` | string | ❌ | 默认模型名。可被 `agents.json` 的 `model` 覆盖。 |
| `apiKey` | string / `${ENV_VAR}` | ❌ | API 密钥，运行时插值 `${ENV_VAR}`。缺失变量 fail-fast 抛 `ConfigError`。也可写成 `keyEnv: "ENV_VAR"` 的旧形式（自动转 `apiKey: "${ENV_VAR}"`）。 |

### 2.3 ${VAR} 插值规则（`interpolateEnv`）

- 仅识别 `${IDENT}`，IDENT = `[A-Za-z_][A-Za-z0-9_]*`
- `$$` → 字面 `$`（不递归、不查 env）
- 缺失变量 → `ConfigError`（区分「显式空串」（合法）与「未定义」（报错））
- 不支持 `${VAR:-default}` 语法、不递归展开

### 2.4 完整示例

```json
{
  "providers": {
    "deepseek": {
      "type": "openai",
      "apiBase": "https://api.deepseek.com/v1",
      "model": "deepseek-v4-pro",
      "apiKey": "${DEEPSEEK_API_KEY}"
    },
    "minimax": {
      "type": "openai",
      "apiBase": "https://api.minimaxi.com/v1",
      "model": "MiniMax-M3",
      "apiKey": "${MINIMAX_API_KEY}"
    },
    "anthropic-deepseek": {
      "type": "anthropic",
      "apiBase": "https://api.deepseek.com/anthropic",
      "model": "deepseek-chat",
      "apiKey": "${DEEPSEEK_API_KEY}"
    }
  }
}
```

---

## 3. `gates.json` —— 质量门配置（声明式 + 多层合并）

**用途**：把 `cargo test` / `clippy` / `fmt` / `e2e smoke` 这类硬验证从 flow 代码里搬到外部配置文件。
业务项目仓里声明「跑哪些门」，与 `providers.json` / `agents.json` 对称。
**加载**：`loadGates({ repo })` → `Array<gate>`（map by name 后转有序数组）
**执行**：`runGate(gate, deps)` / `runGates(gates, deps)`
**合并**：`mergeGates(builtin, project)` 把内置默认门与项目门按名去重合并。

### 3.1 顶层结构

```json
{
  "gates": {
    "<gate-name>": {
      "cmd": "sh ./scripts/e2e.sh",
      "onFail": "rollback",
      "timeout": 600000
    }
  }
}
```

也接受裸 map（省去外层 `gates` 包裹）。

### 3.2 gate 字段集

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cmd` | string \| string[] | ✅ | 检查命令。字符串走 `sh -c`（shell 自负责 `$VAR`/glob 展开）；数组形式**不**走 shell（每元素直传 execvp，规避命令注入）。`loadGates` 不做 `${VAR}` 插值——shell 自负责。 |
| `cwd` | string | ❌ | 工作目录。**若 `deps.repo` 已知，会校验 cwd 不逃逸 repo**（realpathSync 防符号链接绕过）。 |
| `timeout` | number | ❌ | 单命令超时（ms）。 |
| `onFail` | string | ❌ | 红灯处理策略：`rollback`（默认，抛错给上层 `withSelfModGuard`）/`resume-fix`（回喂 agent 修复一次再重测）/`autofix`（跑确定性修复命令如 `cargo fmt` 后重测）。 |
| `autofixCmd` | string \| string[] | `onFail=autofix` 时必填 | 修复命令。同 `cmd` 形式。 |
| `resumeFix` | function | `onFail=resume-fix` 时必填（也可用 `deps.resumeFix` 注入） | `async (failureOutput, gate) => boolean`，返回 `true` 表示已应用修复，会重测一次。 |
| `onEvent` | function | ❌ | 观测回调 `(event) => void`。dashboard 通过此钩子读门 pass/fail。 |

### 3.3 onFail 策略对比

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `rollback` | 红灯抛 `GateError`，外层 `withSelfModGuard` 硬回滚 | 不可恢复的门（编译失败、E2E 失败） |
| `resume-fix` | 红灯把失败输出回喂 agent 修复 → 重测；仍红则抛错 | 可被 LLM 修复的门（lint、type 错误） |
| `autofix` | 红灯跑确定性修复命令 → 重测验证；仍红则抛错 | 有标准修复动作的门（fmt、`eslint --fix`） |

### 3.4 完整示例

```json
{
  "gates": {
    "lint": {
      "cmd": "npm run lint",
      "onFail": "autofix",
      "autofixCmd": "npm run lint -- --fix",
      "timeout": 180000
    },
    "test": {
      "cmd": ["npm", "test", "--", "--run"],
      "onFail": "rollback",
      "timeout": 600000
    },
    "e2e": {
      "cmd": "sh ./scripts/e2e.sh",
      "cwd": ".",
      "onFail": "rollback",
      "timeout": 1200000
    },
    "type-check": {
      "cmd": "npx tsc --noEmit",
      "onFail": "resume-fix"
    }
  }
}
```

### 3.5 合并语义（mergeGates）

```js
mergeGates(builtin, project) // → 按门名去重，项目级同名覆盖内置，新增追加在后
```

flow 用法（典型）：

```js
import { loadGates, mergeGates } from 'flowcast'

const builtin = [
  { name: 'cargo-test', cmd: 'cargo test --no-fail-fast', onFail: 'rollback', timeout: 600000 },
]
const project = await loadGates({ repo })
const gates = mergeGates(builtin, project)
const results = await runGates(gates, { resumeFix })
```

---

## 4. 三套配置共同的安全约束（重申）

以下约束**横跨三类配置**，违反即 fail-fast：

| 约束 | 来源 | 防护目的 |
|------|------|----------|
| runId / agent name / task.name 走 `assertSafeIdent` 白名单 | `helpers.js` | 防路径穿越 `../../etc/passwd` |
| `transcriptOut` / `pricingFile` / `files[i]` 等路径字段走 `isSafePath` | `executor.js:130` | 防路径逃逸 cwd |
| `extraArgs` 走 `sanitizeExtraArgs` | `executor.js:144` | 防 LLM 注入 `--system-prompt-file /etc/shadow` |
| `gates.cwd` 走 `realpathSync` + `startsWith(repo)` | `quality-gate.js:61` | 防符号链接逃逸 |
| provider 字段白名单 | `provider.js` | 防 `apiKey`/`baseUrl` 等敏感字段被运行时覆盖 |
| `${VAR}` 插值缺失 fail-fast | `provider.js:54` | 防明文密钥漏配时静默用空值发请求 |

完整威胁模型与防御见 [`docs/SECURITY_MODEL.md`](SECURITY_MODEL.md)。

---

## 5. 调试技巧

```bash
# 看某个目录加载到的最终配置（JSON 形式）
node -e "import('./provider.js').then(m => m.loadProviders({repo: '.'}).then(console.log))"

# 清缓存（热更新场景）
node -e "import('./provider.js').then(m => m.clearConfigCache())"

# 看 schema 校验失败的细节
DEBUG=flowcast:* node your-flow.js
```

环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `FLOWCAST_CONFIG_TTL` | 30000 | 进程内配置缓存 TTL（ms）；0 关闭 |
| `HOME` | 系统默认 | 配置加载的机器级根目录（`$HOME/.flowcast`） |