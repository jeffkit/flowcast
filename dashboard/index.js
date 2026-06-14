// dashboard/index.js — 看板对外出口：采集 → 渲染 → 落盘。
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { collectRuns } from './collect.js'
import { renderHtml } from './render.js'
import { flowcastDir } from '../dirs.js'

export { collectRuns } from './collect.js'
export { renderHtml } from './render.js'

/**
 * 生成看板 HTML 文件。
 * @param {object} o
 *   - repo     仓根目录（默认 cwd）
 *   - out      输出 HTML 路径（默认 <flowcastDir>/dashboard.html，即 .flowcast/ 或兼容的 .flowx/）
 *   - staleMs  僵尸阈值
 *   - now      注入当前时间（测试用）
 * @returns {{out:string, model:object}}
 */
export function generateDashboard({ repo = process.cwd(), out, staleMs, now } = {}) {
  const model = collectRuns(repo, { staleMs, now })
  const outPath = out ?? `${flowcastDir(repo)}/dashboard.html`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, renderHtml(model))
  return { out: outPath, model }
}
