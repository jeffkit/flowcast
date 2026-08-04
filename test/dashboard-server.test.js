// test/dashboard-server.test.js — HTTP server 单测。
//
// 全程临时 HOME + 临时项目目录，不碰真实 ~/.flowcast/projects.json。
// server.js 的 projects.js 调用走默认 home（读 process.env.HOME），
// 故测试用 t.test 的 before/after 把 HOME 临时切到临时目录。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../dashboard/server.js'

let tmpHome
let savedHome

before(() => {
  savedHome = process.env.HOME
  tmpHome = mkdtempSync(join(tmpdir(), 'flowcast-server-home-'))
  process.env.HOME = tmpHome
})

after(() => {
  process.env.HOME = savedHome
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
})

// 起一个 server，返回 { server, baseUrl, fetchJson }
async function boot(over = {}) {
  // 随机端口：用 0 让 OS 分配，再从 server.address() 取实际端口。
  const server = await startServer({ port: 0, host: '127.0.0.1', ...over })
  const addr = server.address()
  const baseUrl = `http://127.0.0.1:${addr.port}`
  const api = (p, opt = {}) => fetch(`${baseUrl}${p}`, {
    headers: { 'content-type': 'application/json', ...(opt.headers ?? {}) },
    ...opt,
  })
  return { server, baseUrl, api }
}

function makeFakeRepo(name) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), `flowcast-srv-repo-${name}-`)))
  mkdirSync(join(repo, '.flowcast', 'runs'), { recursive: true })
  return repo
}

test('GET /api/health → {ok:true}', async () => {
  const { server, api } = await boot()
  try {
    const res = await api('/api/health')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
  } finally { server.close() }
})

test('GET /api/projects：初始为空', async () => {
  const { server, api } = await boot()
  try {
    const res = await api('/api/projects')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { projects: [] })
  } finally { server.close() }
})

test('POST /api/projects：登记后出现在列表里（含内联 summary）', async () => {
  const { server, api } = await boot()
  try {
    const repo = makeFakeRepo('post')
    const res = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: repo, name: 'my-repo' }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.project.path, repo)
    assert.equal(body.project.name, 'my-repo')
    assert.ok(body.project.id)

    const list = await (await api('/api/projects')).json()
    assert.equal(list.projects.length, 1)
    assert.equal(list.projects[0].id, body.project.id)
    // 新接口：列表内联轻量 summary（含 stats），无需前端再发 N 次 getModel
    assert.ok(list.projects[0].summary, '应带 summary 字段')
    assert.ok(list.projects[0].summary.stats, 'summary 应含 stats')
    assert.equal(list.projects[0].summary.stats.total, 0, '空项目 total=0')
  } finally { server.close() }
})

test('POST /api/projects：path 缺失 → 400', async () => {
  const { server, api } = await boot()
  try {
    const res = await api('/api/projects', { method: 'POST', body: JSON.stringify({}) })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /path 必填/)
  } finally { server.close() }
})

test('POST /api/projects：路径不存在 → 404', async () => {
  const { server, api } = await boot()
  try {
    const res = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: '/definitely/not/here' }),
    })
    assert.equal(res.status, 404)
  } finally { server.close() }
})

test('POST /api/projects：无 .flowcast/.flowx → 400', async () => {
  const { server, api } = await boot()
  try {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'plain-')))
    try {
      const res = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path: plain }),
      })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.code, 'ENO_FLOWCAST_DIR')
    } finally { rmSync(plain, { recursive: true, force: true }) }
  } finally { server.close() }
})

test('POST /api/projects：重复登记 → 409', async () => {
  const { server, api } = await boot()
  try {
    const repo = makeFakeRepo('dup2')
    const r1 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ path: repo }) })
    assert.equal(r1.status, 201)
    const r2 = await api('/api/projects', { method: 'POST', body: JSON.stringify({ path: repo }) })
    assert.equal(r2.status, 409)
    const body = await r2.json()
    assert.equal(body.code, 'EPROJECT_EXISTS')
  } finally { server.close() }
})

test('GET /api/projects/:id/model：返回完整 model（含 runs 数组）', async () => {
  const { server, api } = await boot()
  try {
    const repo = makeFakeRepo('model')
    const created = await (await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: repo }),
    })).json()
    const id = created.project.id

    const res = await api(`/api/projects/${encodeURIComponent(id)}/model`)
    assert.equal(res.status, 200)
    const model = await res.json()
    // model 顶层字段（与 collectRuns 返回一致）
    assert.equal(model.repo, repo)
    assert.ok(Array.isArray(model.runs), 'runs 应为数组')
    assert.ok(Array.isArray(model.roots))
    assert.ok(model.stats && typeof model.stats === 'object')
    assert.ok(model.byWorkflow && typeof model.byWorkflow === 'object')
    assert.ok(typeof model.generatedAt === 'string')
  } finally { server.close() }
})

test('GET /api/projects/:id/model：项目不存在 → 404', async () => {
  const { server, api } = await boot()
  try {
    const res = await api('/api/projects/ghost-id/model')
    assert.equal(res.status, 404)
  } finally { server.close() }
})

test('PATCH /api/projects/:id：改名生效', async () => {
  const { server, api } = await boot()
  try {
    const repo = makeFakeRepo('patch')
    const created = await (await api('/api/projects', {
      method: 'POST', body: JSON.stringify({ path: repo }),
    })).json()
    const id = created.project.id

    const res = await api(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'renamed-xyz' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.project.name, 'renamed-xyz')
  } finally { server.close() }
})

test('DELETE /api/projects/:id：移除后该项目不再出现', async () => {
  const { server, api } = await boot()
  try {
    const repo = makeFakeRepo('del')
    const created = await (await api('/api/projects', {
      method: 'POST', body: JSON.stringify({ path: repo }),
    })).json()
    const id = created.project.id

    const res = await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    const list = await (await api('/api/projects')).json()
    // 测试间共享同一 HOME，列表可能含别测试造的项目；只断言「这个 id 已不在」。
    assert.ok(!list.projects.some(p => p.id === id), `项目 ${id} 应已被删除`)
    // 再删一次 → 404（幂等性：服务端识别为不存在）
    const again = await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
    assert.equal(again.status, 404)
  } finally { server.close() }
})

test('GET /：已构建 dist 时返回 index.html（200 HTML）', async () => {
  const { server, baseUrl } = await boot()
  try {
    const res = await fetch(baseUrl + '/')
    // dist 已构建（随包发布）→ 返回 index.html
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/html/)
    const html = await res.text()
    assert.match(html, /<div id="root">/, '应含 React 挂载点')
  } finally { server.close() }
})
