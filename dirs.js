// dirs.js — flowcast 目录约定
//
// 新项目使用 .flowcast/，旧项目 .flowx/ 向后兼容。
// 规则：.flowcast/ 存在则用它，否则 fallback 到 .flowx/（旧项目无需迁移）。

import { existsSync } from 'fs'
import { join } from 'path'

// 每个 repo 路径只探一次磁盘，之后从缓存读（run 期间目录结构不会改变）。
const _cache = new Map()

/** 清除目录缓存（测试用：避免跨测试的缓存污染）。 */
export function clearFlowcastDirCache() { _cache.clear() }

/**
 * 返回项目的 flowcast 数据根目录。
 * 新项目：<repo>/.flowcast/
 * 旧项目兼容：<repo>/.flowx/（.flowcast/ 不存在时）
 */
export function flowcastDir(repo = process.cwd()) {
  if (_cache.has(repo)) return _cache.get(repo)
  const fc = join(repo, '.flowcast')
  const result = existsSync(fc) ? fc : join(repo, '.flowx')
  _cache.set(repo, result)
  return result
}
