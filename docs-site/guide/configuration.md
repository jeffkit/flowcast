# 配置分层

flowx 的一条铁律：**provider / agent 配置绝不硬编码在代码里**。配置按内容性质三分，密钥永不入仓。

## 三分原则

| 内容 | 放哪 |
|------|------|
| 通用 flow 逻辑 + adapter + provider/agent schema | **flowx 库**（本仓） |
| 项目特定配置（质量门命令、provider/agent 名） | **项目仓 `.flowx/`**（committed） |
| 机器级状态 + 密钥（run checkpoints、API key） | **`~/.flowx/`** 或 gitignore 的 `.flowx/` |

## 多层加载与覆盖

provider 与 agent 配置都按这个顺序加载，**后者覆盖前者**：

```
1. ~/.flowx/providers.{json,yaml,yml,js,mjs}      ← 机器级
2. <repo>/.flowx/providers.{json,yaml,yml,js,mjs} ← 项目级覆盖
```

每个目录只取第一个命中的文件（按 `json → yaml → yml → js → mjs` 优先级）。YAML 需要可选的 `yaml` 包（lazy import），不装则用 JSON。

## Provider 配置

provider 描述"用哪个模型 / 端点 / 密钥"。执行器 adapter 只消费**解析后的通用 bundle**，不认识具体 provider 名。

`~/.flowx/providers.json`：

```json
{
  "providers": {
    "deepseek": {
      "type": "openai",
      "apiBase": "https://api.deepseek.com/v1",
      "model": "deepseek-v4-pro",
      "apiKey": "${DEEPSEEK_API_KEY}"
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

字段：

- `type` — 协议族：`openai` | `anthropic`。
- `apiBase` — 端点（兼容旧字段 `base`）。
- `model` — 模型名。
- `apiKey` — 用 `${ENV_VAR}` 运行时插值（兼容旧字段 `keyEnv`）。

### `${VAR}` 插值（密钥永不入仓）

`apiBase` / `model` / `apiKey` 里的 `${VAR}` 在运行时从进程 env 展开：

- 仅识别 `${IDENT}`（`IDENT = [A-Za-z_][A-Za-z0-9_]*`）。
- `$$` → 字面 `$`（不递归、不查 env）。
- **缺失变量 fail-fast**：未定义即报错（区分"显式空串"合法与"未定义"报错）。
- 不支持默认值语法 `${VAR:-x}`，不递归。

所以配置文件可以放心提交——明文密钥永远只在你的 shell 环境变量里。

## Agent 配置

agent profile 把"执行器 + 可选 provider + 调用配置"打包成具名引用，flow / L3 按名字引用。

`~/.flowx/agents.json`：

```json
{
  "agents": {
    "recursive-deepseek": { "executor": "recursive", "provider": "deepseek", "maxSteps": 60 },
    "claude-sonnet":      { "executor": "claude", "model": "claude-sonnet-4" },
    "cursor-default":     { "executor": "cursor", "model": "auto" }
  }
}
```

### 执行器能力分层：provider 给谁有效

执行器是否接受外部 provider，由它有没有 `applyProvider` 翻译器派生：

| 执行器 | 类型 | provider |
|--------|------|----------|
| `recursive` / `aider` / `claude` | BYO-LLM | ✅ 可注入 |
| `cursor` / `agent` / `gemini` / `codex` / `agy` | 锁定型 | ❌ 给了即 fail-fast |

给锁定型执行器配 `provider` 会在 `resolveAgent` 时立刻报错，提示去掉 provider、改用它自带的 model 选择。

### 在代码里解析

```js
import { loadAgents, loadProviders, resolveAgent } from '@force-lab/flowx'

const [agents, providers] = await Promise.all([
  loadAgents({ repo }),
  loadProviders({ repo }),
])

const a = resolveAgent('recursive-deepseek', agents, { providers })
// → { executor, run, opts }（opts 已注入翻译后的 env / model）
await a.run('实现 X', { cwd: repo, ...a.opts })
```

## dry-run

`FLOWX_DRY_RUN=1`（或 flow 的 `--dry-run`）下：

- `runAgent` / `resolveAgent` 返回**假执行器**（不调真 CLI、无需真 key）。
- 质量门**直接判过**（不 spawn）。
- 但 provider-locked 校验**仍恒做**（结构冒烟也要抓配置错误）。

这让你能在不烧 API、不跑构建的前提下跑通整个 flow 骨架——这是写 flow / 改原语时的标准验证手段。
