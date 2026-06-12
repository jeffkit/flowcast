# 示例

flowx 仓内的 `flows/` 与 `orchestrator/examples/` 提供了几个可读、可跑的活样例。

## 黄金样例：并行分析 → 质量门 → 收口

`orchestrator/examples/golden-sample.flow.js` 既是 L3 codegen 的 few-shot，又是 `validateFlow` 的 dry-run 验证靶子。它 100% 遵循 [FLOW_API](/api/) 契约：只 import `@force-lab/flowx`，只用契约原语，编排全在 `main()`。

```js
import { parseArgs } from 'util'
import {
  Checkpoint, setWorkdir,
  loadAgents, loadProviders, resolveAgent,
  runGate, parallel, notify, setHitlBackend,
} from '@force-lab/flowx'

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
FLOWX_DRY_RUN=1 flowx run ./orchestrator/examples/golden-sample.flow.js --goal "src,lib"
```

## force-dev：标准开发工作流

`flows/force-dev.js` 是 FORCE Lab 标准开发流：**建分支 → 写码 → 审查 → PR**，全程断点续跑，关键节点 HITL 确认。

```bash
flowx force-dev --feature add-login --repo .
flowx force-dev --run-id run-1234567890      # 断点续跑，不需重传参数
flowx list                                    # 列出所有 run
```

它综合用到了 `Checkpoint`、`runAgentChain`（跨 CLI 回退）、`parallel`、`waitForInput`、`runGates`、git 原语。批量模式下可由 `todo-drain` 通过 `--prompt-file` 调用，跳过 HITL。

## todo-drain：批量消化 TODO

`flows/todo-drain.js` 展示「**拆多组 → fanOut 并发跑子 flow → 隔离 → 汇总**」这套通用编排：

```bash
flowx run ./flows/todo-drain.js --todo ./TODO.md --repo .
flowx run ./flows/todo-drain.js --dry-run        # 只显示分组，不执行
```

设计要点：

- TODO.md 的**解析 / 分组 / 回写**是业务特定逻辑，留在本脚本。
- 「拆成多组 → 并发跑子 flow → 隔离 → 汇总」是**通用编排**，复用 flowx 的 `fanOut` 原语。
- L3 接单分拆（`orchestrateMulti`）只需把 `parseTodos` / `groupTodos` 换成「LLM 生成任务清单」，**同样喂给 `fanOut`**——手写编排与 LLM 分拆共用同一底座。

## L3 一行需求

不写 flow，直接让 L3 生成并执行：

```bash
# 单 flow
flowx orchestrate "审计 src/ 并修复 lint 问题" --repo . --agent claude-sonnet

# 接单分拆并发
flowx orchestrate "实现 README 的全部 TODO" --split --concurrency 3
```

详见 [L3 编排](/guide/orchestration)。

## 可观测看板

跑过若干 run 后，生成只读 HTML 看板查看父子运行树、僵尸进程、质量门红灯：

```bash
flowx dashboard --repo . --open
# → .flowx/dashboard.html
```

详见 [API · Dashboard](/api/dashboard)。
