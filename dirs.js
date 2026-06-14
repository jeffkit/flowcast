// dirs.js — flowcast 目录约定
//
// 新项目使用 .flowcast/，旧项目 .flowx/ 向后兼容。
// 规则：.flowcast/ 存在则用它，否则 fallback 到 .flowx/（旧项目无需迁移）。
//
// dry-run 隔离：FLOWCAST_DRY_RUN=1 时所有状态（memory/checkpoint/failure-context）写到
// ~/.flowcast/dryrun/ 而非真实项目目录。这样 dry-run 跑完不污染真盘，clean up 一次 rm -rf 即可。
// 通过 env 自动派生（flowcastDir() 不传 dryRun 时根据 process.env.FLOWCAST_DRY_RUN 判断），
// 调用方不用每个都传。
//
// 缓存失效：flowcastDir() 缓存 <repo> → path 映射，但用 mtime 守护——
// 下次访问时 statSync 一下 .flowcast/ 目录的 mtime，若与缓存时记录的
// 不一致则重新探测。生产环境 .flowcast/ mtime 几乎不变（一次性 stat 即可），
// 跨 run 用户从 .flowx/ 升级到 .flowcast/（或反过来）也能正确切换。

import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isDryRun } from './dry-run.js'

// dry-run 根目录：~/.flowcast/dryrun/；无 HOME 时用系统 tmp
function dryRunRoot() {
  const home = process.env.HOME
  if (home) return join(home, '.flowcast', 'dryrun')
  return join(tmpdir(), 'flowcast-dryrun')
}

// 缓存：key `${repo}|${dryRun}` → { path, fcMtimeMs, ... }
// fcMtimeMs 是缓存时刻 .flowcast/ 目录的 mtime（不存在则为 0）；
// 下次访问时 statSync 比较，mtime 变了就重新探测。
const _cache = new Map()

/** 清除目录缓存（测试用：避免跨测试的缓存污染）。 */
export function clearFlowcastDirCache() { _cache.clear() }

/**
 * 返回项目的 flowcast 数据根目录。
 * 新项目：<repo>/.flowcast/
 * 旧项目兼容：<repo>/.flowx/（.flowcast/ 不存在时）
 * dry-run：~/.flowcast/dryrun/（与真盘隔离，runId-by-runId 落盘便于排查）
 *
 * dryRun 缺省 = 根据 FLOWCAST_DRY_RUN 自动判断；显式传 false 强制走真盘路径。
 */
export function flowcastDir(repo = process.cwd(), { dryRun = isDryRun() } = {}) {
  const key = `${repo}|${dryRun}`
  // dry-run 路径是固定根（~/.flowcast/dryrun 或 tmp 兜底），无需失效检测
  if (dryRun) {
    const cached = _cache.get(key)
    if (cached) return cached.path
    const path = dryRunRoot()
    _cache.set(key, { path, fcMtimeMs: 0 })
    return path
  }
  const fc = join(repo, '.flowcast')
  const currentFcMtime = (() => {
    try { return statSync(fc).mtimeMs } catch { return 0 }
  })()
  const cached = _cache.get(key)
  // 缓存命中 + mtime 一致 → 直接返回；否则重新探测
  if (cached && cached.fcMtimeMs === currentFcMtime) {
    return cached.path
  }
  const path = currentFcMtime > 0 ? fc : join(repo, '.flowx')
  _cache.set(key, { path, fcMtimeMs: currentFcMtime })
  return path
}
