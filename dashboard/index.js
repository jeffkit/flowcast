// dashboard/index.js — 看板对外出口：采集 → 渲染 → 落盘。
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { collectRuns } from './collect.js'
import { renderHtml } from './render.js'
import { flowcastDir } from '../dirs.js'
import { loadAgents } from '../executor.js'
import { scanAgents } from '../scan.js'
import { listFlows } from '../flows-registry.js'

export { collectRuns } from './collect.js'
export { renderHtml } from './render.js'

/**
 * 组装单个项目的完整看板 model（runs + agents + workflows 合并）。
 *
 * server.js 的 `/api/projects/:id/model` 与 generateDashboard 都复用本函数，
 * 保证「静态 HTML 看板」与「在线 dashboard 服务」看到的是同一份数据口径。
 * agent/workflow 采集是 best-effort：失败时不阻断 runs 展示（兼容最小可用），
 * 仅在 model._collectWarning 留一条诊断信息。
 *
 * @param {object} o
 *   - repo     仓根目录（默认 cwd）
 *   - staleMs  僵尸阈值
 *   - now      注入当前时间（测试用）
 * @returns {Promise<object>} 可直接 JSON.stringify 给前端的 model 对象
 */
export async function buildModel({ repo = process.cwd(), staleMs, now } = {}) {
  const model = collectRuns(repo, { staleMs, now })
  // 并行采集 agents + workflows（均为只读、互不依赖），失败不阻断 runs 展示。
  try {
    const [configured, scanned, workflows] = await Promise.all([
      loadAgents({ repo }),
      scanAgents(),
      Promise.resolve(listFlows({ repo })),
    ])
    model.agents = mergeAgents(configured, scanned)
    model.workflows = workflows
  } catch (e) {
    model.agents = []
    model.workflows = { project: [], user: [], all: [] }
    model._collectWarning = `agents/workflows 采集失败：${e?.message ?? e}`
  }
  return model
}

/**
 * 生成看板 HTML 文件。
 *
 * 薄封装：buildModel 组装数据 → renderHtml 渲染 → 落盘。
 * 数据组装逻辑已抽到 buildModel，本函数仅负责「生成静态 HTML 文件」这一职责。
 *
 * @param {object} o
 *   - repo     仓根目录（默认 cwd）
 *   - out      输出 HTML 路径（默认 <flowcastDir>/dashboard.html，即 .flowcast/ 或兼容的 .flowx/）
 *   - staleMs  僵尸阈值
 *   - now      注入当前时间（测试用）
 * @returns {Promise<{out:string, model:object}>}
 */
export async function generateDashboard({ repo = process.cwd(), out, staleMs, now } = {}) {
  const model = await buildModel({ repo, staleMs, now })
  const outPath = out ?? `${flowcastDir(repo)}/dashboard.html`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, renderHtml(model))
  return { out: outPath, model }
}

/**
 * 把「配置的 agent profile」与「本机 CLI 装机扫描」合并成 dashboard Agents tab 用的清单。
 *
 * 合并规则：
 *   - 配置过的 profile：带上其 model/provider/executor 配置，并附加 scan 的 installed/authed/ready。
 *     scan 按 profile.executor（即 cli 名）匹配；匹配不到则 installed=false。
 *   - 已安装但未配置的 CLI：作为「可用但未配置」项列出（installed=true, configured=false），
 *     让用户知道本机还能用哪些 agent。
 *
 * 不携带任何 apiKey 明文——provider 只保留其名（profile.provider 字段），密钥永不进 model。
 *
 * @param {Record<string, object>} configured  loadAgents 的结果
 * @param {Array} scanned                        scanAgents 的结果
 * @returns {Array<{name, executor, model, provider, configured, installed, authed, authDetail, ready, path}>}
 */
function mergeAgents(configured = {}, scanned = []) {
  const scanByCli = new Map(scanned.map(s => [s.cli, s]))
  const out = []

  // 1. 配置过的 profile
  for (const [name, profile] of Object.entries(configured)) {
    const cli = profile?.executor
    const s = cli ? scanByCli.get(cli) : undefined
    scanByCli.delete(cli)  // 已消费，剩下的就是「未配置但已安装」
    out.push({
      name,
      executor: cli ?? null,
      model: profile?.model ?? null,
      provider: profile?.provider ?? null,  // 仅 provider 名，无密钥
      configured: true,
      installed: s?.installed ?? false,
      authed: s?.authed ?? null,
      authDetail: s?.authDetail ?? null,
      ready: s?.ready ?? false,
      path: s?.path ?? null,
    })
  }

  // 2. 已安装但未配置的 CLI
  for (const s of scanByCli.values()) {
    if (!s.installed) continue  // 未安装的不重复列（scan 全量含未安装，这里只关心「装了但没配」）
    out.push({
      name: `(unconfigured) ${s.cli}`,
      executor: s.cli,
      model: null,
      provider: null,
      configured: false,
      installed: true,
      authed: s.authed,
      authDetail: s.authDetail,
      ready: s.ready,
      path: s.path,
    })
  }

  return out
}

