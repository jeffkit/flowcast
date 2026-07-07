# 从零到第一次跑通

本页是一条**端到端、可复制**的路径：从一台没装过 flowcast 的机器，到第一次成功跑通 `flowcast orchestrate`。照着做即可，每步都给了"怎么确认成功"。

> **只想自己写一条 5 步 flow？** 本页是 L3 路径。如果你不想让 agent 替你生成 flow，跳到 [快速上手 · 第一个 flow](/guide/getting-started#第一个-flow)，配好后直接 `flowcast run ./my-flow.js`。

## 前置条件

- **Node ≥ 20**：`node --version` 确认。
- 一个目标 git 仓库（你要让 flowcast 在里面干活）。
- 至少一个可用的 LLM API key（如 DeepSeek / Anthropic）或一个已登录的 coding agent CLI（如 cursor-agent）。

## 第 1 步：让目标仓能解析 `flowcast`

这是最容易踩的坑：L3 生成的 flow 会 `import 'flowcast'`，**目标仓必须能解析到它**，否则 `orchestrate` 会在预检阶段毫秒级 fail-fast。

::: code-group
```bash [已发布到 npm]
cd <你的目标仓>
npm install flowcast
```
```bash [尚未发布 / 想用源码]
git clone https://github.com/jeffkit/flowcast.git ~/projects/flowcast
cd <你的目标仓>
npm install ~/projects/flowcast
```
:::

**确认成功**：
```bash
node -e "import('flowcast').then(m => console.log('ok:', Object.keys(m).length, 'exports'))"
# 期望输出：ok: <数字> exports
```

## 第 2 步：写最小 `~/.flowcast` 配置

provider / agent 配置放机器级 `~/.flowcast/`，密钥用 `${ENV}` 运行时插值（**明文永不入仓**）。

```bash
mkdir -p ~/.flowcast
```

`~/.flowcast/providers.json`（BYO-LLM 执行器才需要；只用 cursor 等锁定型可跳过）：
```json
{
  "providers": {
    "deepseek": {
      "type": "openai",
      "apiBase": "https://api.deepseek.com/v1",
      "model": "deepseek-v4-pro",
      "apiKey": "${DEEPSEEK_API_KEY}"
    }
  }
}
```

`~/.flowcast/agents.json`：
```json
{
  "agents": {
    "claude-sonnet":      { "executor": "claude", "model": "claude-sonnet-4" },
    "cursor-default":     { "executor": "cursor", "model": "auto" },
    "recursive-deepseek": { "executor": "recursive", "provider": "deepseek", "maxSteps": 60 }
  }
}
```

设置密钥环境变量（缺变量会 fail-fast）：
```bash
export DEEPSEEK_API_KEY=sk-xxxx
```

::: tip 选哪个 agent
**BYO-LLM**（`recursive` / `aider` / `claude`）可注入 provider（端点/模型/密钥）。
**锁定型**（`cursor` / `gemini` / `codex`）自管鉴权——给它配 `provider` 会 fail-fast，只用它自带的 `model`。
只想最快跑通、本机已登录 cursor-agent 的话，用 `cursor-default` 最省事（无需 provider/key）。
:::

## 第 3 步：dry-run 冒烟（不烧 API）

先用 dry-run 跑通骨架，确认环境/配置没问题，再上真的。dry-run 下执行器与质量门被 fake，**不烧 API、不跑构建**。

```bash
FLOWCAST_DRY_RUN=1 flowcast orchestrate "在 README 末尾加一行 hello" --repo . --agent cursor-default
```

**确认成功**：看到生成 → 校验 → 执行（fake）走完，结尾 `✓ orchestrate 完成 exit=0`，并在 `.flowcast/runs/<run-id>/` 下有 `flow.mjs`、`state.json`、`run.log.jsonl`。

::: warning dry-run 验证的边界
dry-run 只验证**结构 / 骨架 / 配置**（能不能生成合法 flow、配置是否齐全、流程能否走通）。
它**不**验证真实 LLM 产出质量与真实构建结果。所以 dry-run 通过 ≠ 真能产出正确代码——上线前务必跑一次真的。
:::

## 第 4 步：真实跑一次

去掉 `FLOWCAST_DRY_RUN`，用真实 agent 端到端执行：

```bash
flowcast orchestrate "在 README 末尾加一行 hello" --repo . --agent cursor-default
```

**确认成功**：`exit=0`，目标仓里 README 真的被改了；`.flowcast/runs/<run-id>/report.md` 有可读摘要。

## 第 5 步（可选）：续跑与看板

```bash
# 中断后用同一个 run-id 续跑，已完成步骤会 [skip]
flowcast orchestrate "..." --run-id <上次的 run-id>

# 生成只读可观测看板
flowcast dashboard --repo . --open
```

## 卡住了？

直接看 [排错 / FAQ](/guide/troubleshooting) —— 列了所有常见 fail-fast 报错和修法。
