# 质量门与自改沙箱

这两个原语解决同一个问题的两面：**让 AI 安全地改代码**——质量门负责"红灯怎么处理"，自改沙箱负责"失败怎么回滚"。

## 质量门（runGate / runGates）

质量门把测试、lint、构建等检查纳入 flow，红灯时按声明的策略处理。它抽象了 `self-improve.sh` 里反复出现的「跑检查 → 红灯按策略处理」模式。

```js
import { runGate, runGates } from 'flowcast'

await runGate({
  name: 'test',
  cmd: 'npm test',
  cwd: repo,
  onFail: 'rollback',   // 默认
})
```

### 三种 onFail 策略

| 策略 | 行为 | 对应场景 |
|------|------|----------|
| `rollback`（默认） | 红灯直接抛错，交给 `withSelfModGuard` 硬回滚 | `cargo test` / `clippy` |
| `resume-fix` | 红灯把失败输出喂回 agent 修一次，再重测；仍红则抛错 | 可自动修的失败 |
| `autofix` | 跑 `autofixCmd` 修复后**重测验证**；验证通过返回 pass，仍失败抛 `GateError`，不触发回滚 | `fmt` 这类确定性修复 |

```js
// resume-fix：把失败输出喂回 agent 修一次
await runGate(
  { name: 'lint', cmd: 'npm run lint', onFail: 'resume-fix' },
  { resumeFix: async (failureOutput, gate) => {
      await runAgent(`修复 lint 错误：\n${failureOutput}`, { cli: 'claude' })
      return true   // 返回 true 表示已应用修复，会触发重测
  } },
)

// autofix：跑确定性修复命令
await runGate({ name: 'fmt', cmd: 'cargo fmt --check', onFail: 'autofix', autofixCmd: 'cargo fmt' })
```

### 顺序跑多个门

```js
await runGates([
  { name: 'fmt',    cmd: 'cargo fmt --check', onFail: 'autofix', autofixCmd: 'cargo fmt' },
  { name: 'clippy', cmd: 'cargo clippy -- -D warnings', onFail: 'rollback' },
  { name: 'test',   cmd: 'cargo test', onFail: 'rollback' },
], { resumeFix })
```

任意门红灯（rollback / resume-fix 仍失败）即抛错。

### dry-run 友好

`isDryRun()` 为真时，质量门**不 spawn、直接判过**（结构校验用，不烧构建时间）。所以你可以 `FLOWCAST_DRY_RUN=1` 跑通整个 flow 骨架。

### 观测

传 `onEvent` 回调（或 `cp.event`）把质量门 pass/fail 写进 jsonl，看板据此标红灯：

```js
await runGate(gate, { onEvent: (e) => cp.event(e.event, e) })
```

## 自改安全沙箱（withSelfModGuard）

`withSelfModGuard` 是 recursive（`self-improve.sh`）与 revengers（Self-Mod Guard）各自独立收敛到的同一个原语：**让 AI 改自己的代码时不致命**。

```js
import { withSelfModGuard, captureBaseline } from 'flowcast'

const result = await withSelfModGuard(async ({ repo, baseline }) => {
  await runAgent('重构 X 模块', { cli: 'claude' })
  try {
    await runGates(gates, deps)       // 质量门把关
    await gitCommitAll(repo, 'refactor X')
    return { verdict: 'committed' }   // 已自行提交，不回滚
  } catch (e) {
    return { verdict: 'rolled-back' } // 触发硬回滚到 baseline
  }
}, { repo })
```

### 核心契约

1. 跑之前要有 **baseline commit**，且工作树**干净**（否则拒绝）。
2. `fn` 抛错 / 返回 `verdict='rolled-back'` → **硬回滚**到 baseline（`reset --hard` + `clean -fd`）。
3. `verdict='committed'` → 调用方已自行 commit，不回滚。
4. `verdict='skip-commit'` → 故意留脏，不回滚。
5. `verdict='panic-preserved'` → 保留现场不回滚（留给人诊断）。

### 与质量门的组合范式

```
captureBaseline → 工作树干净检查
       ↓
withSelfModGuard 包住整段自改
       ↓
agent 改代码 → runGates 把关
       ↓                  ↓
   全绿 → commit      红灯 → rolled-back → 硬回滚到 baseline
```

这套组合就是 flowcast「让 agent 安全自改」的标准姿势：**生成 → 验证 → 要么提交、要么干净回到原点**，永远不会留下半成品的脏状态。

完整签名见 [API · 质量门 / 自改沙箱](/api/quality-gate)。
