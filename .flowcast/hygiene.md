# flowcast 卫生铁律

> 本文件被 pge flow 的 Generator/repair prompt 自动读取并注入（见 pge.flow.js 的 `loadHygiene`）。
> 改动这里 = 改变 Generator 在本仓写代码时遵守的规矩。保持精炼、可执行。

## 模块与导出

- **ESM only**：所有 `.js` 用 `import`/`export`，不写 `require`/`module.exports`。
  package.json 已 `"type": "module"`。
- **新增模块要在入口导出**：在 `index.js` 里 `export` 新增的公开 API；
  内部模块用明确命名（不加 `export` 即私有）。
  flowcast 的公共 API 表面是契约（见 `orchestrator/FLOW_API.md`），新增公开原语
  要同步更新 FLOW_API.md，否则 codegen 不可见。
- **禁止 `import` 子路径**：`import { x } from 'flowcast'` 合法；
  `import { x } from 'flowcast/spawn'` 违反 FLOW_API 契约（仅 dashboard/SDK 宿主可用）。

## 测试

- **每个新功能/修复都要有测试**：`test/*.test.js` 下，用 Node 内置 `node:test` +
  `node:assert`。不引入 jest/mocha 等外部 runner。
- **测试要快**：单测不依赖网络、不 spawn 真实 CLI。需要子进程的场景用 `spawnCapture`
  + mock 或 `--dry-run`。
- **改了核心原语（Checkpoint/loop/runGate/parallel 等）必须跑全量 `node --test test/*.test.js`**。

## 代码风格

- **不引入新依赖**除非必要；flowcast 刻意保持零运行时依赖（devDependencies 仅
  测试/构建用）。新增依赖要在 PR 里说明理由。
- **错误用 flowcast 自定义 Error 类**（`FlowcastError`/`GateError`/`SpawnError`/
  `TimeoutError`/`ConfigError` 等，见 `errors.js`），不抛裸 `Error`。
- **注释写「为什么」不写「是什么」**：代码自解释命名，注释解释决策与陷阱。
