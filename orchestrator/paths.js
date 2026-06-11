// orchestrator/paths.js — 模板/样例/契约的绝对路径（独立模块，避免 index ↔ generate 循环依赖）
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const _dir = dirname(fileURLToPath(import.meta.url))

export const FLOW_SKELETON = join(_dir, 'templates', 'flow-skeleton.js')
export const GOLDEN_SAMPLE = join(_dir, 'examples', 'golden-sample.flow.js')
export const FLOW_API_DOC = join(_dir, 'FLOW_API.md')
