// flowcast/internal — 内部 helper 入口（测试 / 工具脚本用）
//
// 本文件是 flowcast 库"内部 surface"的二次入口。下游 flow 应当从 'flowcast' 导入，
// 不要从 'flowcast/internal' 导入——这些 API 没有稳定性承诺、可能随时改。
//
// 当前含：
//   - clearFlowcastDirCache（dirs.js 测试 helper）
//   - sweepStaleTmp（subflow.js SIGKILL 兜底，启动时调）
//   - AGENT_COOLDOWN_* 常量（agent.js 内部，但测试用 env 覆盖时可能需要读默认值）
//
// 何时新增到 internal：测试 / 工具脚本需要，但不属于"下游 flow 应依赖的契约"。
// 何时不要新增：可观测面板 / dashboard API（这些该进 'flowcast' 公开）。

export { clearFlowcastDirCache } from './dirs.js'
export { sweepStaleTmp } from './subflow.js'
export { AGENT_COOLDOWN_BASE_MS, AGENT_COOLDOWN_MAX_MS } from './agent.js'