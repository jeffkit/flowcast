# run --supervise 参考（跑 flow，挂了自动修到跑通）

> `flowcast run <flow> --supervise` = 跑一个已有 flow，挂在哪就让 agent 修哪，用同一 runId 续跑，直到跑通。

## 它解决什么问题

你有一个 flow，但它跑不通（某个 step 报错、编排逻辑有 bug）。手动排查 → 改 flow → 重跑很繁琐。
`--supervise` 让一个 agent 替你做这个循环：**跑 → 失败 → 读错误 → 改 flow → 续跑**，直到 flow 完全跑通。

## 和 orchestrate 的区别（核心）

| | `orchestrate` | `run --supervise` |
|---|---|---|
| 输入 | 一段**编排需求**（生成 flow） | 一个**已有 flow 文件** |
| flow 代码 | 一次性生成后**锁定不变** | 跑挂了就**被 agent 修**，迭代到跑通 |
| 续跑语义 | 同一 runId，flow 不变 | 同一 runId，**flow 被改后从失败处续跑** |
| 适合 | 需求 → 生成 → 跑一次 | 已有 flow 跑不通 → 边修边跑到通 |

一句话：**orchestrate 创造 flow，supervise 修 flow。**

## 怎么用

```bash
# 基本用法：跑 my-flow.js，挂了就用 default agent 修，续跑直到通
flowcast run .flowcast/flows/my-flow.js --supervise --repo .

# 指定修复用的 agent（缺省用 ~/.flowcast/agents.json 的 default）
flowcast run .flowcast/flows/my-flow.js --supervise --agent cursor-default --repo .

# 指定续跑的 run-id（接着上次没跑通的继续）
flowcast run .flowcast/flows/my-flow.js --supervise --run-id super-1234567890 --repo .

# 调整迭代上限（默认 5 轮）
flowcast run .flowcast/flows/my-flow.js --supervise --max-turns 10 --repo .
```

## 工作机制

```
for 每一轮（最多 maxTurns）:
  1. 用 runFlow 跑 flow（同一 runId）
     - flow 内部 Checkpoint 跳过已成功 step，从失败 step 重跑
  2. 若 exit=0 → 跑通了，结束（return 0）
  3. 若失败：
     a. 收集失败详情（stderr + state.json 里失败 step 的 error）
     b. 调修复 agent：把失败详情 + 当前 flow 代码喂给它，让它只改 flow 代码
     c. 写回 flow 文件，用 validateFlow 校验（语法/import/dry-run）
        校验不过则把错误回喂 agent 再改（最多额外 2 次）
  4. 续跑（回到第 1 步）
```

## 续跑语义（重要）

`--supervise` 用**同一 runId** 多轮续跑。因为 flow 内部 Checkpoint 的特性：
- **失败的 step 不写 `completed`**，续跑时会**重新执行**（用修后的新代码）
- **成功的 step 会被跳过**（复用已通过的结果）

所以 supervisor 修完 flow 续跑时，天然"从失败处继续"，不会重跑已通过的 step。

**局限**：如果 supervisor 改的是失败 step **之前**某个已成功 step 的代码，那个 step 会被跳过（用旧结果）。supervisor 聚焦修失败 step 的代码即可——这是合理边界。

## 修复范围

supervisor 的 agent **只改 flow 文件本身**（修 flow 代码的 bug、调整 step 的 prompt、改编排逻辑）。它**不动业务代码**——业务代码是 flow 内部 agent step 的产物，不是 supervisor 的职责。

## 何时用 / 不用

| 场景 | 选择 |
|------|------|
| 有个 flow 跑不通，想让 agent 自动修到跑通 | ✅ `run --supervise` |
| 想从需求生成一个全新 flow | `orchestrate`（supervise 不生成 flow）|
| flow 跑通了，只是想再跑一次 | `run`（普通跑，不需要 supervise）|
| flow 本身没问题，是业务代码的 bug | 直接让 agent 改业务代码，supervise 只修 flow |
