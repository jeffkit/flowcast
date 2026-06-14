# API · 实用工具

跨模块复用的纯函数与启动时兜底。

## `assertSafeIdent(name, field = 'name')`

任务/资源标识符白名单校验。返回 `name`，不合法时抛 `Error`。

```js
import { assertSafeIdent } from 'flowcast'

assertSafeIdent('task-a')          // OK
assertSafeIdent('../escape')       // throw: contains unsafe characters
assertSafeIdent('.hidden')         // throw: 必须以字母数字开头
```

**字符规则**：以字母数字开头/结尾，中间允许字母数字、`.`、`_`、`-`。

**用途**：`subflow` 的 `task.name`、`writeFailureContext` / `readAndConsumeFailureContext` 的 `tag` 都走此校验。path.join 不阻止 `..` 解析，必须用白名单字符拦在源头。

## `sweepStaleTmp({ olderThanMs, baseDir })`

扫 `tmpdir` 清理 stale 的 flowcast/flowx 临时文件。返回被清理的文件名列表。失败静默。

```js
import { sweepStaleTmp } from 'flowcast/internal'

// 通常在 bin/flowcast.js 启动时调一次
sweepStaleTmp({ olderThanMs: 60 * 60 * 1000 })  // 1h 前的全清
```

清理范围：

- `flowcast-codex-*` / 旧 `flowx-codex-*` —— codex adapter 临时输出
- `*-failure-context.md.consuming.*.owner.*` —— failure-context 跨进程消费 sidecar 残留

**不在主入口** `flowcast`：本函数在 `flowcast/internal`（无稳定性承诺，仅给 CLI 启动 / 工具脚本用）。bin/flowcast.js 启动时调一次。

## 内部 helper（`flowcast/internal`）

下列 API 在 `flowcast/internal` 入口导出，**不保证稳定性**，仅供测试 / 工具脚本用。下游 flow 不要 import。

| 名称 | 用途 |
|------|------|
| `clearFlowcastDirCache` | dirs.js 缓存清空（测试用） |
| `sweepStaleTmp` | 同上 |
| `AGENT_COOLDOWN_BASE_MS` | agent.js 冷却默认值（30s） |
| `AGENT_COOLDOWN_MAX_MS` | agent.js 冷却上限（8min） |
