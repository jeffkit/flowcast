# flowcast quickstart 模板

一个**最小可跑**的 flowcast 项目：clone → install → dry-run → 真跑。
适合作为你新建 flow 项目的起点，或验证本机环境是否就绪。

## 用法

把这个目录拷出来单独用（或直接在这里跑）：

```bash
cp -r examples/quickstart ~/my-flowcast-project
cd ~/my-flowcast-project
npm install
```

> `package.json` 里依赖 `"flowcast": "^0.2.0"`（v0.2.0 已发到 npm）。
> 想锁定主仓未发布的最新 commit，可改用 `"flowcast": "github:jeffkit/flowcast"`。

### 1. 先 dry-run（零配置、不烧 API）

```bash
npm run dry
```

执行器被 fake，整条 flow 骨架会跑通，产物写到 `.flowcast/runs/<run-id>/`。
看到 `✓ done` 即环境就绪。

### 2. 配置一个 agent（真跑前）

把示例配置拷到机器级目录：

```bash
mkdir -p ~/.flowcast
cp agents.example.json ~/.flowcast/agents.json
```

- 用 **`cursor-default`**（本机已登录 cursor-agent）最省事，无需 API key。
- 用 `claude-sonnet` 等 BYO-LLM 则还需 `~/.flowcast/providers.json` + 对应 API key 环境变量。

### 3. 真跑

```bash
npm start
# 或自定义目标 / 指定 agent：
node flow.mjs --repo . --goal "把 src/ 里的 console.log 清掉" --agent cursor-default
```

### 4. 断点续跑

用**同一个 `--run-id`** 再跑一次，已完成的 step 会 `[skip]`：

```bash
node flow.mjs --repo . --run-id <上次的 run-id>
```

## 这个模板演示了什么

- `Checkpoint` 把 flow 拆成可续跑的 `cp.step`
- `resolveAgent` 按 profile 名解析执行器（dry-run 自动 fake）
- `setHitlBackend` + `notify` 的 HITL
- 只 `import flowcast`（+ `util`），与 L3 生成的 flow 同构

## 下一步

- 文档站：https://jeffkit.github.io/flowcast/
- 从零到第一次跑通：https://jeffkit.github.io/flowcast/guide/from-zero
- 给 AI 使用（skill + 速查）：https://jeffkit.github.io/flowcast/guide/for-ai
- 排错 / FAQ：https://jeffkit.github.io/flowcast/guide/troubleshooting
