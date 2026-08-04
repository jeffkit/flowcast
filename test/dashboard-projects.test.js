// test/dashboard-projects.test.js — 项目登记薄原语单测。
//
// 全程在临时 home + 临时项目目录里跑，不碰真实 ~/.flowcast/projects.json。
// 遵守 AGENTS.md「测试用假执行器」约定：不烧 API、不依赖外部环境。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadProjects, saveProjects, addProject, removeProject, renameProject,
  touchProject, listRecent, getProject, projectsFile, registerProjectIfNew,
} from '../dashboard/projects.js'

// ── 夹具：每次测试一个独立 home + N 个假项目目录 ───────────────────
function tempHome() { return mkdtempSync(join(tmpdir(), 'flowcast-proj-home-')) }

function makeFakeRepo(home, name) {
  // 在 home 同级建项目目录，避免污染 home/.flowcast
  const repo = mkdtempSync(join(tmpdir(), `flowcast-proj-repo-${name}-`), { encoding: 'utf8' })
  mkdirSync(join(repo, '.flowcast', 'runs'), { recursive: true })
  // macOS 下 /tmp 是 /private/tmp 的软链；realpathSync 解析后返回真实路径，
  // addProject 内部也会 realpathSync，测试比较时统一用真实路径避免不一致。
  return realpathSync(repo)
}

test('loadProjects：空 home 返回空数组（文件不存在不抛）', () => {
  const home = tempHome()
  try {
    assert.deepEqual(loadProjects(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('addProject + loadProjects：登记后能读到，字段完整', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'a')
    const entry = addProject(repo, { home })
    assert.equal(entry.path, repo)
    assert.equal(entry.name, expectBasname(repo))
    assert.ok(entry.id, 'id 应生成')
    assert.ok(entry.addedAt, 'addedAt 应存在')
    assert.equal(entry.lastOpenedAt, entry.addedAt)

    const list = loadProjects(home)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, entry.id)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('addProject：路径不存在 → 抛 ENOENT_PROJECT_PATH', () => {
  const home = tempHome()
  try {
    const ghost = join(home, 'nope', 'deep')
    assert.throws(() => addProject(ghost, { home }), /项目路径不存在/)
    assert.deepEqual(loadProjects(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('addProject：无 .flowcast/.flowx → 抛 ENO_FLOWCAST_DIR', () => {
  const home = tempHome()
  try {
    const plain = mkdtempSync(join(tmpdir(), 'plain-dir-'))
    try {
      assert.throws(() => addProject(plain, { home }), /不是 flowcast 项目/)
      assert.deepEqual(loadProjects(home), [])
    } finally { rmSync(plain, { recursive: true, force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('addProject：同 path 重复登记 → 抛 EPROJECT_EXISTS，不重复写入', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'dup')
    const first = addProject(repo, { home })
    let caught
    try { addProject(repo, { home }) } catch (e) { caught = e }
    assert.ok(caught, '应抛错')
    assert.match(caught.message, /项目已登记/)
    assert.equal(caught.code, 'EPROJECT_EXISTS')
    assert.equal(caught.existingId, first.id)
    assert.equal(loadProjects(home).length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('addProject：用户自定义 name 生效', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'named')
    const entry = addProject(repo, { name: '我的服务', home })
    assert.equal(entry.name, '我的服务')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('removeProject：按 id 移除；不存在则幂等不报错', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'rm')
    const entry = addProject(repo, { home })
    removeProject(entry.id, home)
    assert.equal(loadProjects(home).length, 0)
    // 再删一次不抛
    removeProject(entry.id, home)
    removeProject('nonexistent', home)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('renameProject：改名生效；空名抛错；不存在抛错', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'rn')
    const entry = addProject(repo, { home })
    renameProject(entry.id, 'new-name', home)
    assert.equal(getProject(entry.id, home).name, 'new-name')
    assert.throws(() => renameProject(entry.id, '   ', home), /不能为空/)
    assert.throws(() => renameProject('ghost', 'x', home), /项目不存在/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('touchProject：更新 lastOpenedAt；不存在静默忽略', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'touch')
    const entry = addProject(repo, { home })
    const before = entry.lastOpenedAt
    // 确保时间戳推进（touch 用 new Date()）
    touchProject(entry.id, home)
    const after = getProject(entry.id, home).lastOpenedAt
    assert.ok(new Date(after) >= new Date(before), 'lastOpenedAt 应推进')
    // 不存在的 id 不抛
    touchProject('ghost', home)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listRecent：按 lastOpenedAt desc 排序，limit 生效', async () => {
  const home = tempHome()
  try {
    const r1 = makeFakeRepo(home, 'r1')
    const r2 = makeFakeRepo(home, 'r2')
    const r3 = makeFakeRepo(home, 'r3')
    const e1 = addProject(r1, { home })
    // 微延迟保证 add/touch 的时间戳严格递增（ISO 毫秒粒度）
    await new Promise(r => setTimeout(r, 5))
    const e2 = addProject(r2, { home })
    await new Promise(r => setTimeout(r, 5))
    const e3 = addProject(r3, { home })
    await new Promise(r => setTimeout(r, 5))
    // 故意打乱：touch e3 再 touch e1 → e1 最晚，应排第一；e3 次之
    touchProject(e3.id, home)
    await new Promise(r => setTimeout(r, 5))
    touchProject(e1.id, home)

    const recent = listRecent(2, home)
    assert.equal(recent.length, 2)
    assert.equal(recent[0].id, e1.id, '最近摸的 e1 应排第一')
    assert.equal(recent[1].id, e3.id, 'e3 第二（比 e2 晚摸）')
    // 完整列表也应是 e1 > e3 > e2
    const all = listRecent(undefined, home)
    assert.equal(all[0].id, e1.id)
    assert.equal(all[2].id, e2.id)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('saveProjects：原子写（文件落盘格式正确）', () => {
  const home = tempHome()
  try {
    const list = [
      { id: 'x-abc123', name: 'X', path: '/tmp/x', addedAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-02T00:00:00.000Z' },
    ]
    saveProjects(list, home)
    const file = projectsFile(home)
    assert.ok(existsSync(file), '文件应存在')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.projects.length, 1)
    assert.equal(raw.projects[0].id, 'x-abc123')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('loadProjects：损坏的 JSON → 容错返回空数组', () => {
  const home = tempHome()
  try {
    mkdirSync(join(home, '.flowcast'), { recursive: true })
    writeFileSync(projectsFile(home), '{ not valid json')
    assert.deepEqual(loadProjects(home), [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('id 生成：不同路径 → 不同 id；slug 可读', () => {
  const home = tempHome()
  try {
    const r1 = makeFakeRepo(home, 'alpha')
    const r2 = makeFakeRepo(home, 'beta')
    const e1 = addProject(r1, { home })
    const e2 = addProject(r2, { home })
    assert.notEqual(e1.id, e2.id)
    // slug 前缀来自 basename，应含可读片段（这里 repo 是 mkdtemp 随机名，至少 id 不为空）
    assert.ok(e1.id.length > 0 && e2.id.length > 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('兼容老 .flowx 项目目录', () => {
  const home = tempHome()
  try {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'flowcast-legacy-repo-')))
    try {
      mkdirSync(join(repo, '.flowx', 'runs'), { recursive: true })
      const entry = addProject(repo, { home })
      assert.equal(entry.path, repo)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// mkdtemp 的目录名形如 flowcast-proj-repo-a-XXXX，basename 取出来用于断言默认 name
function expectBasname(repo) {
  return repo.split('/').pop()
}

// ── registerProjectIfNew（自动登记，幂等）──────────────────────

test('registerProjectIfNew：首次登记返回 entry，第二次返回 null（幂等）', () => {
  const home = tempHome()
  try {
    const repo = makeFakeRepo(home, 'auto1')
    const e1 = registerProjectIfNew(repo, home)
    assert.ok(e1, '首次应返回 entry')
    assert.equal(e1.path, repo)
    const e2 = registerProjectIfNew(repo, home)
    assert.equal(e2, null, '重复登记应返回 null（幂等，不抛）')
    assert.equal(loadProjects(home).length, 1, '列表仍只有 1 个')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('registerProjectIfNew：非 flowcast 项目静默跳过（返回 null，不抛）', () => {
  const home = tempHome()
  try {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'plain-auto-')))
    try {
      const result = registerProjectIfNew(plain, home)
      assert.equal(result, null, '非 flowcast 目录应返回 null')
      assert.equal(loadProjects(home).length, 0, '不应登记')
    } finally { rmSync(plain, { recursive: true, force: true }) }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('registerProjectIfNew：不存在的路径静默跳过', () => {
  const home = tempHome()
  try {
    const result = registerProjectIfNew('/nonexistent/path/xyz', home)
    assert.equal(result, null)
    assert.equal(loadProjects(home).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

