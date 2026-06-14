# 示例

flowcast 仓内的 `examples/` 与 `orchestrator/examples/` 提供了几个可读、可跑的活样例。

## 黄金样例：并行分析 → 质量门 → 收口

`orchestrator/examples/golden-sample.flow.js` 既是 L3 codegen 的 few-shot，又是 `validateFlow` 的 dry-run 验证靶子。它 100% 遵循 [FLOW_API](/api/) 契约：只 import `flowcast`，只用契约原语，编排全在 `main()`。

```js
import { parseArgs } from 'util'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runGate, parallel, notify, setHitlBackend,
} from 'flowcast'

// ...骨架处理参数解析 / Checkpoint / loadAgents / HITL 后端...

async function main() {
  const targets = goal.split(',').map(s => s.trim()).filter(Boolean)
  const agent = opts.agent ?? 'cursor-default'

  // 并行：每个 target 派给一个 agent 分析
  const findings = await cp.step('analyze', () => parallel(
    targets.map(t => () => runProfile(agent, `Analyze ${t} and report issues.`)),
  ))

  // 质量门：跑一个检查（dry-run 下自动判过）
  await cp.step('gate.lint', () => runGate({ name: 'lint', cmd: opts.gate ?? 'true', cwd: repo, onFail: 'rollback' }))

  // 收口：综合所有发现
  const summary = await cp.step('synthesize', () =>
    runProfile(agent, `Synthesize these findings:\n${findings.map(String).join('\n---\n')}`))

  cp.done({ targets: targets.length })
  await notify(`analysis done for ${targets.length} target(s)`)
}
```

跑它（dry-run 验证骨架）：

```bash
FLOWCAST_DRY_RUN=1 flowcast run ./orchestrator/examples/golden-sample.flow.js --goal "src,lib"
```

## force-dev：FORCE Lab 标准开发工作流

`force-dev` 是 FORCE Lab 的标准开发 flow：**建分支 → 写码 → 审查 → PR**，全程断点续跑，关键节点 HITL 确认。它由 [force-lab 仓](https://github.com/jeffkit/force-lab) 维护，不随 flowcast 包发布，需要单独安装。

```bash
# 从 force-lab 仓安装（一次性）
flowcast flows install /path/to/force-lab/flows/force-dev.js

# 之后在任意编码项目里使用
flowcast run force-dev --feature add-login --repo .
flowcast run force-dev --run-id run-1234567890      # 断点续跑，不需重传参数
flowcast list                                        # 列出所有 run（依赖已安装的 force-dev）
```

它综合用到了 `Checkpoint`、`runAgentChain`（跨 CLI 回退）、`waitForInput`、`runGates`、git 原语。批量模式下可通过 `--prompt-file` 跳过 HITL 确认。

## goal-drive：goal-driven loop 样例

`examples/goal-drive.js` 展示用 `loop` 原语「**反复跑 agent 直到目标达成**」：

```bash
# 安装后按名字跑
flowcast flows install ./examples/goal-drive.js
flowcast run goal-drive --goal "让 npm test 全绿" --gate "npm test" --repo .
flowcast run goal-drive --dry-run   # 假执行器，验证骨架
```

设计要点：`loop / memory / quality-gate / runAgent` 都是 flowcast 一等原语，本 flow 只做薄编排。「反复跑到达成、且越跑越聪明」是通用能力。

## L3 一行需求

不写 flow，直接让 L3 生成并执行：

```bash
# 单 flow
flowcast orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet

# 接单分拆并发
flowcast orchestrate "实现 README 的全部 TODO" --split --concurrency 3
```

详见 [L3 编排](/guide/orchestration)。

## 可观测看板

跑过若干 run 后，生成只读 HTML 看板查看父子运行树、僵尸进程、质量门红灯：

```bash
flowcast dashboard --repo . --open
# → .flowcast/dashboard.html
```

详见 [API · Dashboard](/api/dashboard)。
