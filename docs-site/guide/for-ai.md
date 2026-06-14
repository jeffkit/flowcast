# 给 AI 使用

flowcast 的使用者，很多时候本身就是一个 **AI agent**——它被丢给 flowcast，要拿它来解决任务。flowcast 自己的哲学就是"给生成 flow 的 AI 一份受控词汇表"；这一页把同样的思路用到**使用方 AI** 身上。

## 两种交付：skill + 单页速查

### flowcast skill（随仓发布）

仓库里有 `skills/flowcast/SKILL.md`——一个可被 Cursor / Claude 等装载的 skill。它自动触发、自带：

- **何时用 / 不用** 的判断
- **最小 bootstrap**（Node、安装、`~/.flowcast` 最小配置、dry-run 冒烟）
- **入口决策树**（orchestrate / `--split` / 手写 flow / force-dev 怎么选）
- **能力词汇表**（手写 flow 只用这些原语）
- **排错对照表**（fail-fast 报错 → 修法）
- **边界**（不是运行时、不做 DAG、dry-run 验证什么）

把它放进你的 skills 目录即可让"使用 flowcast 的 AI"开箱即用。

### `/llms.txt` 单页速查

[/llms.txt](/llms.txt) 是一份**可整页塞进 context** 的浓缩速查（能力清单 + 调用约定 + 禁止项 + 错误信号）。给 AI 喂这一页，它就能正确地用 flowcast 干活，而不必读完整站。

## 入口决策树（文字版）

```
任务来了
├─ 一次性单步 / 纯读代码 / 无中断风险 → 不用 flowcast
├─ 一行需求、单目标 → flowcast orchestrate "<目标>" --repo . --agent <name>
├─ 大目标、可拆成多个独立子任务 → flowcast orchestrate "<大目标>" --split --concurrency N
├─ 流程固定、要精细控制（条件分支/重试/特定 HITL 点）→ 手写 flow，flowcast run ./my-flow.js
└─ 标准开发流（建分支→写码→审查→PR）→ flowcast run force-dev --feature <name> --repo .
   （需先安装：flowcast flows install /path/to/force-lab/flows/force-dev.js）
```

选 agent：

```
要注入自己的端点/模型/密钥（BYO-LLM）？
├─ 是 → recursive / aider / claude（可配 provider）
└─ 否，用 CLI 自带鉴权 → cursor / gemini / codex（给 provider 会 fail-fast）
```

## 最小可复制流程

```bash
# 1. 全局安装 flowcast CLI
npm install -g flowcast

# 2. 目标仓能解析 flowcast（L3 orchestrate 必需）
cd <repo> && npm install flowcast

# 3. 最小配置（只用 cursor 等锁定型可跳过 providers）
mkdir -p ~/.flowcast
# 写 ~/.flowcast/agents.json: { "agents": { "cursor-default": {"executor":"cursor","model":"auto"} } }

# 4. dry-run 冒烟（不烧 API）
FLOWCAST_DRY_RUN=1 flowcast orchestrate "测试目标" --repo . --agent cursor-default

# 5. 真跑
flowcast orchestrate "真实目标" --repo . --agent cursor-default

# 6. 中断后续跑（同一个 run-id）
flowcast orchestrate "..." --run-id <run-id>
```

完整步骤见 [从零到第一次跑通](/guide/from-zero)，撞错见 [排错 / FAQ](/guide/troubleshooting)。

## 给 AI 的硬约束（记牢这几条）

1. 手写 flow **只能** `import flowcast`（+ `util`）；需要文件/git/进程 → 走 flowcast 原语，**别裸调 `child_process`/`fs`**。
2. 每个 `cp.step` 的 `key` **唯一**；续跑用**同一个 `--run-id`**。
3. 锁定型执行器（cursor/gemini/codex）**别配 provider**。
4. 密钥用 `${ENV}`，**明文永不入仓**。
5. dry-run 只验证结构，**上线前跑一次真的**。
6. flowcast 是编排层，**不替你管运行时**（不存业务状态、不做 DAG）。
