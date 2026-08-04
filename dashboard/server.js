// dashboard/server.js — 全局聚合 dashboard 的 HTTP 服务（node:http，零框架依赖）。
//
// 职责双线：
//   1. JSON API（/api/*）—— 项目登记薄 CRUD + 单项目 model（复用 buildModel）
//   2. 静态托管 dashboard/app/dist/（React 构建产物），SPA fallback 到 index.html
//
// 守住 AGENTS.md「最小依赖」核心约束：只用 node:http，不引入 express/fastify。
// 路由手工分发；body 解析只读一次 content-length 内的 JSON。

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  listRecent, addProject, removeProject, renameProject, touchProject, getProject,
} from './projects.js'
import { buildModel, collectRuns } from './index.js'
import {
  configFilePath, readConfigLayer,
  saveAgentProfile, deleteAgentProfile,
  saveProvider, deleteProvider,
  listKnownExecutors,
} from './config-store.js'
import { visualizeFlow } from './flow-viz.js'
import { analyzeFlow } from './flow-analyzer.js'
import { readFileSync } from 'node:fs'
import { scanAgents } from '../scan.js'
import { listFlows } from '../flows-registry.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const APP_DIST = join(__dirname, 'app', 'dist')

// 静态文件 MIME 表（够用即可；缺省走 application/octet-stream）。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
}

/**
 * 启动 dashboard server。
 *
 * @param {object} [opts]
 *   - port     端口（默认 4173）
 *   - host     绑定地址（默认 127.0.0.1，仅本机访问）
 *   - staleMs  僵尸阈值（透传 buildModel）
 * @returns {Promise<import('node:http').Server>} 已 listen 的 server（测试可 .close()）
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? 4173
  const host = opts.host ?? '127.0.0.1'
  const staleMs = opts.staleMs

  const server = createServer((req, res) => {
    // 每个请求一个 async 作用域；未捕获错误统一兜底成 500。
    handle(req, res, { staleMs }).catch(err => {
      sendJson(res, 500, { error: 'internal', message: err?.message ?? String(err) })
    })
  })

  await new Promise(resolve => server.listen(port, host, resolve))
  return server
}

// ── 请求分发 ──────────────────────────────────────────────────────

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  const method = req.method

  // CORS：开发态 vite (5173) 与本服务 (4173) 跨端口；生产同源用不上但留着无害。
  setCors(res)

  // 预检
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // ── API 路由 ──
  if (path === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true })

  if (path === '/api/projects' && method === 'GET') {
    return handleListProjects(res, ctx)
  }
  if (path === '/api/projects' && method === 'POST') {
    const body = await readJson(req)
    if (!body?.path) return sendJson(res, 400, { error: 'path 必填' })
    try {
      const entry = addProject(body.path, { name: body.name })
      return sendJson(res, 201, { project: entry })
    } catch (e) {
      return sendProjectError(res, e)
    }
  }

  // /api/projects/:id[/model]
  const projMatch = path.match(/^\/api\/projects\/([^/]+)(\/model)?$/)
  if (projMatch) {
    const id = decodeURIComponent(projMatch[1])
    const wantModel = projMatch[2] === '/model'

    if (wantModel && method === 'GET') return handleProjectModel(res, id, ctx)
    if (!wantModel && method === 'DELETE') return handleProjectDelete(res, id)
    if (!wantModel && method === 'PATCH') return handleProjectPatch(req, res, id)
  }

  // ── config 路由（agent/provider 配置读写）──
  if (path.startsWith('/api/config/')) {
    return handleConfigRoute(req, res, path, method, url)
  }

  // ── flow 可视化路由 ──
  if (path === '/api/flows/list' && method === 'GET') {
    return handleListFlows(res)
  }
  if (path === '/api/flows/analyze' && method === 'GET') {
    return handleFlowAnalyze(res, url)
  }
  if (path === '/api/flows/viz' && method === 'GET') {
    return handleFlowViz(res, url)
  }

  // ── 静态资源（SPA）──
  if (method === 'GET') return serveStatic(req, res, path)
  return sendJson(res, 404, { error: 'not found', path })
}

// ── API handlers ──────────────────────────────────────────────────

/**
 * GET /api/projects — 列出全部已登记项目，每项内联轻量 summary（只含 stats + 时间戳）。
 *
 * 关键：这里只取 collectRuns 产出的 stats 字段，丢弃 runs/steps/events 等大体量详情。
 * 否则一个含 66 个 run 的项目会返回 2.6MB，前端解析极慢且容易卡死。
 * summary 每项仅几百字节。
 */
async function handleListProjects(res, ctx) {
  const entries = listRecent()
  const now = Date.now()
  // 并行采集每个项目的 stats（collectRuns 是 CPU/IO 密集，并行缩短总耗时）。
  const summaries = await Promise.all(entries.map(async p => {
    try {
      const model = collectRuns(p.path, { staleMs: ctx.staleMs, now })
      return {
        ...p,
        summary: {
          stats: model.stats,
          generatedAt: model.generatedAt,
        },
      }
    } catch (e) {
      // 单个项目采集失败不阻断整个列表；前端展示「采集失败」占位。
      return { ...p, summary: null, summaryError: e?.message ?? String(e) }
    }
  }))
  return sendJson(res, 200, { projects: summaries })
}

async function handleProjectModel(res, id, ctx) {
  const p = getProject(id)
  if (!p) return sendJson(res, 404, { error: '项目不存在', id })
  // touch 更新「最近使用」（打开项目详情即视为一次访问）。
  try { touchProject(id) } catch { /* 容忍并发删除等竞态 */ }
  try {
    const model = await buildModel({ repo: p.path, staleMs: ctx.staleMs })
    return sendJson(res, 200, model)
  } catch (e) {
    return sendJson(res, 500, { error: 'model 采集失败', message: e?.message ?? String(e) })
  }
}

async function handleProjectDelete(res, id) {
  if (!getProject(id)) return sendJson(res, 404, { error: '项目不存在', id })
  removeProject(id)
  return sendJson(res, 200, { ok: true, id })
}

async function handleProjectPatch(req, res, id) {
  if (!getProject(id)) return sendJson(res, 404, { error: '项目不存在', id })
  const body = await readJson(req)
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    try {
      renameProject(id, body.name)
    } catch (e) {
      return sendJson(res, 400, { error: e?.message ?? 'rename 失败' })
    }
  }
  if (body?.touch) {
    try { touchProject(id) } catch { /* ignore */ }
  }
  return sendJson(res, 200, { project: getProject(id) })
}

// ── config 路由（agent/provider 配置读写）─────────────────────────

/**
 * 处理 /api/config/* 路由。
 * 路由表：
 *   GET    /api/config/executors                已知 executor 清单 + BYO 标记
 *   GET    /api/config/scan                     scanAgents 装机/凭证状态
 *   GET    /api/config/agents?scope=&repo=      读该层 agent profiles
 *   PUT    /api/config/agents/:name             写 agent profile
 *   DELETE /api/config/agents/:name             删 agent profile
 *   GET    /api/config/providers?scope=&repo=   读该层 providers
 *   PUT    /api/config/providers/:name          写 provider
 *   DELETE /api/config/providers/:name          删 provider
 */
async function handleConfigRoute(req, res, path, method, url) {
  const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'user'
  const repo = url.searchParams.get('repo') || undefined

  // ── 无需 scope 的元数据接口 ──
  if (path === '/api/config/executors' && method === 'GET') {
    return sendJson(res, 200, { executors: listKnownExecutors() })
  }
  if (path === '/api/config/scan' && method === 'GET') {
    try {
      const scanned = await scanAgents()
      return sendJson(res, 200, { agents: scanned })
    } catch (e) {
      return sendJson(res, 500, { error: 'scan 失败', message: e?.message ?? String(e) })
    }
  }

  // ── agents ──
  if (path === '/api/config/agents' && method === 'GET') {
    const file = configFilePath('agents', { scope, repo })
    try {
      const agents = readConfigLayer(file, 'agents')
      return sendJson(res, 200, { agents })
    } catch (e) {
      return sendConfigError(res, e)
    }
  }
  const agentMatch = path.match(/^\/api\/config\/agents\/([^/]+)$/)
  if (agentMatch) {
    const name = decodeURIComponent(agentMatch[1])
    if (method === 'PUT') {
      const body = await readJson(req)
      try {
        const result = saveAgentProfile({ name, profile: body.profile ?? body, scope, repo })
        return sendJson(res, 200, result)
      } catch (e) { return sendConfigError(res, e) }
    }
    if (method === 'DELETE') {
      try {
        const result = deleteAgentProfile({ name, scope, repo })
        return sendJson(res, 200, result)
      } catch (e) { return sendConfigError(res, e) }
    }
  }

  // ── providers ──
  if (path === '/api/config/providers' && method === 'GET') {
    const file = configFilePath('providers', { scope, repo })
    try {
      const providers = readConfigLayer(file, 'providers')
      // 附带每个 ${ENV} 是否已设的状态（前端显示 ✓/✗）
      const checked = checkProviderEnv(providers)
      return sendJson(res, 200, { providers: checked })
    } catch (e) {
      return sendConfigError(res, e)
    }
  }
  const providerMatch = path.match(/^\/api\/config\/providers\/([^/]+)$/)
  if (providerMatch) {
    const name = decodeURIComponent(providerMatch[1])
    if (method === 'PUT') {
      const body = await readJson(req)
      try {
        const result = saveProvider({ name, provider: body.provider ?? body, scope, repo })
        return sendJson(res, 200, result)
      } catch (e) { return sendConfigError(res, e) }
    }
    if (method === 'DELETE') {
      try {
        const result = deleteProvider({ name, scope, repo })
        return sendJson(res, 200, result)
      } catch (e) { return sendConfigError(res, e) }
    }
  }

  return sendJson(res, 404, { error: 'config 路由未匹配', path })
}

/** 给每个 provider 补一个 envSet 字段，表示其 ${ENV_VAR} 是否已设在当前环境中。 */
function checkProviderEnv(providers) {
  const out = {}
  for (const [name, p] of Object.entries(providers)) {
    let envVar = null, envSet = null
    const m = typeof p.apiKey === 'string' ? p.apiKey.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/) : null
    if (m) {
      envVar = m[1]
      envSet = !!process.env[envVar]
    }
    out[name] = { ...p, _envVar: envVar, _envSet: envSet }
  }
  return out
}

/** config-store 的业务错误映射成 HTTP 状态码。 */
function sendConfigError(res, e) {
  const statusMap = {
    EBAD_NAME: 400, EBAD_PROFILE: 400, EBAD_EXECUTOR: 400,
    EBYD_NOT_ALLOWED: 400, EBAD_PATH: 400, EBAD_TIMEOUT: 400,
    EBAD_MAXSTEPS: 400, EBAD_PROVIDER: 400, EBAD_TYPE: 400,
    EBAD_KEY: 400, EPLAINTEXT_KEY: 400, ECONFIG_PARSE: 400,
  }
  const status = statusMap[e?.code] ?? 400
  return sendJson(res, status, { error: e?.message ?? String(e), code: e?.code })
}

// ── flow 可视化 handler ──────────────────────────────────────────

/**
 * GET /api/flows/list
 * 聚合用户级 flow（~/.flowcast/flows/）+ 所有已登记项目的项目级 flow。
 * 每个 flow 带 scope + 来源项目名（用户级则 projectName=null），供前端直接列出。
 */
async function handleListFlows(res) {
  const out = []
  // 1. 用户级 flow
  try {
    const { user } = await listFlows({})
    for (const f of user) out.push({ ...f, projectName: null })
  } catch { /* 用户级目录不存在 → 跳过 */ }
  // 2. 每个已登记项目的项目级 flow
  const projects = listRecent()
  for (const p of projects) {
    try {
      const { project } = await listFlows({ repo: p.path })
      for (const f of project) out.push({ ...f, projectName: p.name, projectPath: p.path })
    } catch { /* 项目目录不可读 → 跳过 */ }
  }
  return sendJson(res, 200, { flows: out })
}

/**
 * GET /api/flows/analyze?file=<path>
 * 静态分析 flow 文件（AST，不执行），返回步骤结构 + 分组。
 */
function handleFlowAnalyze(res, url) {
  const file = url.searchParams.get('file')
  if (!file) return sendJson(res, 400, { error: 'file 参数必填' })
  const absFile = file.startsWith('/') ? file : join(process.cwd(), file)
  let source
  try {
    source = readFileSync(absFile, 'utf8')
  } catch (e) {
    return sendJson(res, 404, { error: `无法读取 flow 文件: ${absFile}`, message: e?.message })
  }
  const result = analyzeFlow(source, absFile)
  return sendJson(res, 200, {
    flowFile: absFile,
    flowName: absFile.split('/').pop().replace(/\.(m?js)$/, ''),
    ...result,
    generatedAt: new Date().toISOString(),
  })
}

/**
 * GET /api/flows/viz?file=<path>&repo=<path>
 * dry-run 指定 flow，返回步骤流（FlowGraph）。
 * dry-run 需 1-3s（fake executor），前端需显示 loading。
 */
async function handleFlowViz(res, url) {
  const file = url.searchParams.get('file')
  const repo = url.searchParams.get('repo')
  if (!file) return sendJson(res, 400, { error: 'file 参数必填' })
  try {
    // 路径安全：解析为绝对路径（防止相对路径注入）
    const absFile = file.startsWith('/') ? file : join(process.cwd(), file)
    const result = await visualizeFlow(absFile, { repo: repo || undefined })
    return sendJson(res, 200, result)
  } catch (e) {
    return sendJson(res, 500, { error: 'flow 可视化失败', message: e?.message ?? String(e) })
  }
}

// 把 projects.js 抛的业务错误映射成合适的 HTTP 状态码。
function sendProjectError(res, e) {
  const map = {
    ENOENT_PROJECT_PATH:  [404, '项目路径不存在'],
    ENOTDIR_PROJECT_PATH: [400, '不是目录'],
    ENO_FLOWCAST_DIR:     [400, '不是 flowcast 项目（缺 .flowcast/.flowx）'],
    EPROJECT_EXISTS:      [409, '项目已登记'],
  }
  const hit = map[e?.code]
  if (hit) return sendJson(res, hit[0], { error: e.message, code: e.code, existingId: e.existingId })
  return sendJson(res, 400, { error: e?.message ?? String(e) })
}

// ── 静态托管（SPA）─────────────────────────────────────────────────

async function serveStatic(req, res, reqPath) {
  // 防路径穿越：规范化后必须仍在 APP_DIST 内。
  const safe = normalize(reqPath).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(APP_DIST, safe)

  // 目录请求 → index.html
  if (reqPath.endsWith('/') || reqPath === '') filePath = join(APP_DIST, 'index.html')

  // 文件不存在 → SPA fallback（前端路由由 react-router 接管，如 /project/xxx）
  if (!existsSync(filePath)) {
    return serveFile(res, join(APP_DIST, 'index.html'))
  }
  const st = await stat(filePath).catch(() => null)
  if (!st) return serveFile(res, join(APP_DIST, 'index.html'))
  if (st.isDirectory()) return serveFile(res, join(filePath, 'index.html'))
  return serveFile(res, filePath)
}

async function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found. 提示：dashboard/app/dist 尚未构建，先 `npm run build`。')
    return
  }
  const data = await readFile(filePath)
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime })
  res.end(data)
}

// ── 工具 ──────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

function setCors(res) {
  // 允许 vite dev server (5173) 跨端口访问本 API (4173)。
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}

/** 读 request body 成 JSON；空 body 返回 {}。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', chunk => { buf += chunk; if (buf.length > 1_000_000) reject(new Error('body 过大')) })
    req.on('end', () => {
      if (!buf.trim()) return resolve({})
      try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('非法 JSON body')) }
    })
    req.on('error', reject)
  })
}
