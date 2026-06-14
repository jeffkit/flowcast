# flowcast flow 编写参考

## 澄清维度（生成代码前必须确认）

| 维度 | 要问的 |
|------|--------|
| 步骤顺序 | 分几步？每步做什么？ |
| HITL | 哪些步骤需要人确认才能继续？ |
| Agent 分工 | 每步用 claude / cursor / gemini 还是外部命令？ |
| 失败处理 | 某步失败：重试 / 跳过 / 停下？ |
| 输出 | 最终产物是文件、PR、消息还是报告？ |

## 完整 flow 模板

```js
#!/usr/bin/env node
/**
 * {flow-name} — {一句话描述}
 *
 * 用法：
 *   flowcast run .flowcast/flows/{flow-name}.js --repo . [--参数 值]
 *   flowcast run .flowcast/flows/{flow-name}.js --run-id <id>  # 续跑
 */
import { parseArgs } from 'util'
import { Checkpoint, runAgent, setWorkdir, parallel, waitForInput } from 'flowcast'

const { values: opts } = parseArgs({
  options: {
    'run-id': { type: 'string' },
    repo:     { type: 'string', default: process.cwd() },
    // 在这里加业务参数
  }
})

const runId = opts['run-id'] ?? `run-${Date.now()}`
const repo  = opts.repo
const cp    = new Checkpoint(runId, `${repo}/.flowcast/runs`)
setWorkdir(repo)

console.log(`\n▶ {flow-name}  run=${runId}  repo=${repo}\n`)

await run()

async function run() {
  // 步骤 1
  await cp.step('p1.step-name', () =>
    runAgent('具体任务描述，告诉 agent 做什么、输出什么格式', { cli: 'claude' })
  )

  // 步骤 2（HITL）
  const approved = await cp.step('p1.approval', async () => {
    const answer = await waitForInput('请确认是否继续？(y/n)')
    return answer === 'y'
  })
  if (!approved) cp.pause('用户未确认', {})

  // 步骤 3（并行）
  const [r1, r2] = await parallel([
    () => runAgent('任务A', { cli: 'claude' }),
    () => runAgent('任务B', { cli: 'claude' }),
  ])

  cp.done({ /* summary */ })
  console.log('\n✓ 完成')
}
```

## Agent 选择建议

| 步骤类型 | 推荐 |
|---------|------|
| 写代码、改文件 | `claude` 或 `cursor` |
| 代码审查（独立视角） | `cursor` 或 `gemini` |
| 机械批量修改 | `aider` |
| 网络搜索、信息汇总 | `claude` |
| git / gh / shell 操作 | `claude`（它会调 Bash） |

## 可用原语速查

```
cp.step(key, fn)         断点续跑的最小单元
cp.done(meta)            收尾
cp.pause(reason, ctx)    HITL 暂停，干净退出
runAgent(prompt, opts)   调用 agent CLI
parallel(thunks, {concurrency?})  并发跑多个任务
fanOut(tasks, opts)      并发多条子 flow（worktree 隔离）
waitForInput(prompt)     等待终端输入
runGate(gate)            运行质量门
runGates(gates)          顺序运行多个质量门
```

全部原语见 `flowcast` 的 `orchestrator/FLOW_API.md`。
