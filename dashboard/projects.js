// dashboard/projects.js — 全局项目登记薄原语（~/.flowcast/projects.json）。
//
// 单个项目的运行历史在各自的 .flowcast/runs/ 下（由 collect.js 采集）；
// 本模块负责「用户登记过哪些项目」这个跨项目的列表——聚合 dashboard 的入口数据。
//
// 设计与 collect.js 一致：纯函数 + 可注入 home（测试不依赖真实 ~）、不烧 API。
// 写盘走 write-rename 原子写（与 checkpoint.js 的 _flush 同模式），SIGKILL 不致文件半写。

import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, statSync, mkdirSync } from 'fs'
import { join, basename, resolve, isAbsolute, dirname } from 'path'
import { homedir } from 'os'

const FILE_VERSION = 1

/** 默认 home：与 dirs.js 的 dryRunRoot 同口径（HOME 优先，无则 os.homedir）。 */
function defaultHome() {
  return process.env.HOME || homedir()
}

/** 登记薄文件路径：<home>/.flowcast/projects.json。 */
export function projectsFile(home = defaultHome()) {
  return join(home, '.flowcast', 'projects.json')
}

/**
 * 读取全部已登记项目。文件不存在或损坏 → 返回空数组（容忍，不抛）。
 * @param {string} [home]
 * @returns {ProjectEntry[]}
 */
export function loadProjects(home) {
  const file = projectsFile(home)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(raw?.projects) ? raw.projects : []
    // 字段补全（容老/容缺）：缺 lastOpenedAt 时回填 addedAt，保证「最近使用」可排序。
    return list.filter(p => p && typeof p.path === 'string').map(normalizeEntry)
  } catch {
    return []
  }
}

/**
 * 原子写整个登记薄（write-rename，POSIX rename 原子）。
 * @param {ProjectEntry[]} list
 * @param {string} [home]
 */
export function saveProjects(list, home) {
  const file = projectsFile(home)
  const data = JSON.stringify({ version: FILE_VERSION, projects: list }, null, 2)
  // 父目录可能不存在（首次写入 ~/.flowcast/），递归创建。
  mkdirSync(dirname(file), { recursive: true })
  // 与 checkpoint.js _flush 同模式：先 .tmp 再 rename。
  const tmp = file + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

/**
 * 登记一个项目。
 *
 * 校验：
 *   - path 必须是已存在的目录（不存在 → 抛 ENOENT 类错误，带可读 message）
 *   - path 会被 resolve + realpath 规范化（消除软链 / 相对路径，保证去重稳定）
 *   - 同 path 不可重复（已登记 → 抛错，带已有项目 id 便于提示）
 *   - 目录下需含 .flowcast/ 或 .flowx/（否则登记了也没东西看 → 抛错）
 *
 * @param {string} path
 * @param {{ name?: string, home?: string }} [opts]
 * @returns {ProjectEntry}
 */
export function addProject(path, opts = {}) {
  const home = opts.home ?? defaultHome()
  if (!isAbsolute(path)) path = resolve(path)
  if (!existsSync(path)) {
    const err = new Error(`项目路径不存在: ${path}`)
    err.code = 'ENOENT_PROJECT_PATH'
    throw err
  }
  // 规范化：解析软链到真实路径，保证「同一项目不会被登记两次」。
  let realPath
  try {
    realPath = realpathSync(path)
  } catch {
    realPath = resolve(path)
  }
  if (!statSync(realPath).isDirectory()) {
    const err = new Error(`不是目录: ${realPath}`)
    err.code = 'ENOTDIR_PROJECT_PATH'
    throw err
  }
  // 必须含 flowcast 数据目录，否则 dashboard 无内容可展示。
  const hasFlowcast = existsSync(join(realPath, '.flowcast')) || existsSync(join(realPath, '.flowx'))
  if (!hasFlowcast) {
    const err = new Error(`目录下未发现 .flowcast/ 或 .flowx/，不是 flowcast 项目: ${realPath}`)
    err.code = 'ENO_FLOWCAST_DIR'
    throw err
  }

  const list = loadProjects(home)
  const dup = list.find(p => p.path === realPath)
  if (dup) {
    const err = new Error(`项目已登记: ${dup.name} (${dup.id})`)
    err.code = 'EPROJECT_EXISTS'
    err.existingId = dup.id
    throw err
  }

  const now = new Date().toISOString()
  const entry = {
    id: makeId(realPath, list),
    name: (opts.name && String(opts.name).trim()) || basename(realPath),
    path: realPath,
    addedAt: now,
    lastOpenedAt: now,
  }
  list.push(entry)
  saveProjects(list, home)
  return entry
}

/**
 * 幂等登记一个项目（自动注册用）。
 *
 * 与 addProject 的区别：所有"不能登记"的情况（路径不存在、非 flowcast 项目、已登记）
 * 都静默跳过、不抛错。用于 flowcast 运行流程时自动把项目加入 dashboard 列表——
 * 用户不用手动打开 dashboard 添加。
 *
 * @param {string} path  项目目录（通常是 process.cwd() 或 --repo）
 * @param {string} [home]
 * @returns {ProjectEntry | null} 新登记返回 entry；已存在或不可登记返回 null
 */
export function registerProjectIfNew(path, home) {
  try {
    return addProject(path, { home })
  } catch (e) {
    // EPROJECT_EXISTS（已登记）/ ENO_FLOWCAST_DIR（非 flowcast 项目）/ ENOENT（路径不存在）
    // → 静默跳过，自动注册不应打断流程执行
    if (e.code === 'EPROJECT_EXISTS' || e.code === 'ENO_FLOWCAST_DIR'
        || e.code === 'ENOENT_PROJECT_PATH' || e.code === 'ENOTDIR_PROJECT_PATH') {
      return null
    }
    // 其他意外错误（如磁盘满、权限问题）仍抛出
    throw e
  }
}

/**
 * 移除一个项目（按 id）。id 不存在时静默忽略（幂等）。
 * @param {string} id
 * @param {string} [home]
 */
export function removeProject(id, home) {
  const list = loadProjects(home)
  const next = list.filter(p => p.id !== id)
  if (next.length !== list.length) saveProjects(next, home)
}

/**
 * 重命名项目。
 * @param {string} id
 * @param {string} name
 * @param {string} [home]
 */
export function renameProject(id, name, home) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('name 不能为空')
  const list = loadProjects(home)
  const p = list.find(x => x.id === id)
  if (!p) {
    const err = new Error(`项目不存在: ${id}`)
    err.code = 'ENO_SUCH_PROJECT'
    throw err
  }
  p.name = trimmed
  saveProjects(list, home)
}

/**
 * 更新 lastOpenedAt 为当前时间（"最近使用"排序依据）。
 * id 不存在 → 静默忽略（容前端打开一个刚被别处删掉的项目）。
 * @param {string} id
 * @param {string} [home]
 */
export function touchProject(id, home) {
  const list = loadProjects(home)
  const p = list.find(x => x.id === id)
  if (!p) return
  p.lastOpenedAt = new Date().toISOString()
  saveProjects(list, home)
}

/**
 * 按「最近使用」(lastOpenedAt desc) 取前 limit 个项目。
 * limit 缺省 → 返回全部（已排序）。
 * @param {number} [limit]
 * @param {string} [home]
 * @returns {ProjectEntry[]}
 */
export function listRecent(limit, home) {
  const sorted = loadProjects(home).slice().sort(byLastOpenedDesc)
  return typeof limit === 'number' ? sorted.slice(0, Math.max(0, limit)) : sorted
}

/** 按 id 精确查找单个项目（不在列表里返回 undefined）。 */
export function getProject(id, home) {
  return loadProjects(home).find(p => p.id === id)
}

// ── 内部工具 ──────────────────────────────────────────────────────

function byLastOpenedDesc(a, b) {
  // lastOpenedAt 缺失视为最早；时间相同回退到 addedAt，保证稳定排序。
  const ta = Date.parse(a.lastOpenedAt ?? a.addedAt ?? 0) || 0
  const tb = Date.parse(b.lastOpenedAt ?? b.addedAt ?? 0) || 0
  return tb - ta
}

function normalizeEntry(p) {
  return {
    id: p.id,
    name: p.name ?? basename(p.path),
    path: p.path,
    addedAt: p.addedAt ?? null,
    lastOpenedAt: p.lastOpenedAt ?? p.addedAt ?? null,
  }
}

/**
 * 生成稳定且唯一的 id：基于 path 的 slug + 短 fnv32-base36 指纹。
 * slug 保证人可读（pge-flowcast / my-service）；指纹避免同名目录碰撞；
 * 冲突时自动追加 -2 / -3。
 */
function makeId(path, existing) {
  const slug = slugify(basename(path))
  const fingerprint = fnv32b36(path).slice(0, 6)
  let base = `${slug}-${fingerprint}`
  // 万一碰撞（极罕见），追加序号。
  let id = base
  let n = 2
  const taken = new Set(existing.map(p => p.id))
  while (taken.has(id)) {
    id = `${base}-${n++}`
  }
  return id
}

function slugify(s) {
  // 小写 + 把非 [a-z0-9] 收敛成单个 -；去前后 -；空串兜底 "project"。
  const out = String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'project'
}

/** 32-bit FNV-1a → base36（与 checkpoint.js sidecar 哈希同算法族，无新依赖）。 */
function fnv32b36(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // h *= 16777619，用 Math.imul 保证 32-bit 溢出语义。
    h = Math.imul(h, 0x01000193)
  }
  // 无符号转 base36。
  return (h >>> 0).toString(36)
}
