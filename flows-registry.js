// flows-registry.js — flow 文件清单扫描（供 dashboard / CLI flows list 复用）
//
// flowcast 没有「工作流中央注册表」：flow 就是磁盘上的 .js/.mjs 文件，散落在两个位置：
//   - 项目级：<repo>/.flowcast/flows/  （向后兼容 <repo>/.flowx/flows/）
//   - 用户级：~/.flowcast/flows/       （向后兼容 ~/.flowx/flows/）
// 本模块把这两个位置扫描成结构化清单，供 dashboard 的 Workflows tab 与 CLI `flows list` 共用。
//
// 与 bin/flowcast.js 的 resolveFlowFile 保持一致的查找语义：项目级两个目录都试、用户级两个目录都试。

import { readdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

const FLOW_EXT = /\.(js|mjs)$/

/** 去掉 .js / .mjs 扩展名，得到 flow 名（如 quickstart）。 */
function flowNameOf(file) {
  return basename(file).replace(FLOW_EXT, '')
}

/**
 * 扫描单个目录下的 flow 文件 → FlowEntry[]。目录不存在或不可读返回 []。
 * @param {string} dir
 * @param {'project'|'user'} scope
 * @returns {Array<{name:string, path:string, scope:'project'|'user'}>}
 */
function scanDir(dir, scope) {
  if (!existsSync(dir)) return []
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    if (!FLOW_EXT.test(f)) continue
    const full = join(dir, f)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    out.push({ name: flowNameOf(f), path: full, scope })
  }
  return out
}

/**
 * 列出项目级 + 用户级的全部 flow 文件。
 *
 * 项目级同时扫描 .flowcast/flows 与 .flowx/flows（与 resolveFlowFile 的「两个都试」语义一致）；
 * 用户级同理扫 ~/.flowcast/flows 与 ~/.flowx/flows。同名 flow 若同时出现在 .flowcast 与 .flowx，
 * 保留 .flowcast 版本（与新项目默认对齐），丢弃 .flowx 重复项。
 *
 * @param {object} [o]
 * @param {string} [o.repo=process.cwd()]  项目根目录
 * @param {string} [o.home=homedir()]      用户主目录（测试可注入）
 * @returns {{project: FlowEntry[], user: FlowEntry[], all: FlowEntry[]}}
 */
export function listFlows({ repo = process.cwd(), home = homedir() } = {}) {
  // 项目级：.flowcast/flows 优先，.flowx/flows 作为兼容补充（同名去重）
  const projectCast = scanDir(join(repo, '.flowcast', 'flows'), 'project')
  const projectLegacy = scanDir(join(repo, '.flowx', 'flows'), 'project')
  const project = dedupeByName(projectCast, projectLegacy)

  // 用户级：同样 .flowcast 优先、.flowx 兼容
  const userCast = scanDir(join(home, '.flowcast', 'flows'), 'user')
  const userLegacy = scanDir(join(home, '.flowx', 'flows'), 'user')
  const user = dedupeByName(userCast, userLegacy)

  return { project, user, all: [...project, ...user] }
}

/**
 * 按 name 去重合并两个清单：primary 中的项优先，secondary 中与 primary 同名的丢弃。
 * （.flowcast/ 优先于 .flowx/ ——与 resolveFlowFile 的 `existsSync(flowCast) ? flowCast : flowX` 一致）
 */
function dedupeByName(primary, secondary) {
  const seen = new Set(primary.map(e => e.name))
  const merged = [...primary]
  for (const e of secondary) {
    if (!seen.has(e.name)) {
      merged.push(e)
      seen.add(e.name)
    }
  }
  return merged
}

/** 用户级 flows 目录（与 bin/flowcast.js 的 USER_FLOWS_DIR 同语义，供 CLI install/remove 复用）。 */
export function userFlowsDir(home = homedir()) {
  return existsSync(join(home, '.flowcast'))
    ? join(home, '.flowcast', 'flows')
    : join(home, '.flowx', 'flows')
}
