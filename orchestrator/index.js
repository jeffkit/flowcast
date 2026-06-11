// orchestrator/ — flowx L3 codegen harness 对外 API
//
// 现状（M1+M2）：契约 + 骨架模板 + 黄金样例 + validateFlow。
// 待补（M3-M5）：generateFlow / runGeneratedFlow。

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const _dir = dirname(fileURLToPath(import.meta.url))

export { validateFlow, scanImports } from './validate.js'

/** 骨架模板与黄金样例的绝对路径（codegen 注入 few-shot 用）。 */
export const FLOW_SKELETON = join(_dir, 'templates', 'flow-skeleton.js')
export const GOLDEN_SAMPLE = join(_dir, 'examples', 'golden-sample.flow.js')
export const FLOW_API_DOC = join(_dir, 'FLOW_API.md')
