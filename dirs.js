// dirs.js — flowcast 目录约定
//
// 新项目使用 .flowcast/，旧项目 .flowx/ 向后兼容。
// 规则：.flowcast/ 存在则用它，否则 fallback 到 .flowx/（旧项目无需迁移）。
//
// dry-run 隔离：FLOWCAST_DRY_RUN=1 时所有状态（memory/checkpoint/failure-context）写到
// ~/.flowx/dryrun/ 而非真实 .flowx/。这样 dry-run 跑完不污染真盘，clean up 一次 rm -rf 即可。
// 通过 env 自动派生（flowcastDir() 不传 dryRun 时根据 process.env.FLOWCAST_DRY_RUN 判断），
// 调用方不用每个都传。

import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { isDryRun } from './dry-run.js'

// dry-run 根目录：~/.flowx/dryrun/ 优先，没有就用系统 tmp
function dryRunRoot() {
  const home = process.env.HOME
  if (home) return join(home, '.flowx', 'dryrun')
  return join(tmpdir(), 'flowcast-dryrun')
}

// 每个 repo 路径只探一次磁盘，之后从缓存读（run 期间目录结构不会改变）。
const _cache = new Map()  // key: `${repo}|${dryRun}` → result

/** 清除目录缓存（测试用：避免跨测试的缓存污染）。 */
export function clearFlowcastDirCache() { _cache.clear() }

/**
 * 返回项目的 flowcast 数据根目录。
 * 新项目：<repo>/.flowcast/
 * 旧项目兼容：<repo>/.flowx/（.flowcast/ 不存在时）
 * dry-run：~/.flowx/dryrun/（与真盘隔离，runId-by-runId 落盘便于排查）
 *
 * dryRun 缺省 = 根据 FLOWCAST_DRY_RUN 自动判断；显式传 false 强制走真盘路径。
 */
export function flowcastDir(repo = process.cwd(), { dryRun = isDryRun() } = {}) {
  const key = `${repo}|${dryRun}`
  if (_cache.has(key)) return _cache.get(key)
  let result
  if (dryRun) {
    result = dryRunRoot()
  } else {
    const fc = join(repo, '.flowcast')
    result = existsSync(fc) ? fc : join(repo, '.flowx')
  }
  _cache.set(key, result)
  return result
}
