// api.ts — 后端 API 的 fetch 封装。
//
// 所有方法返回 Promise；非 2xx 时抛 ApiError（带 status + body）。
// 开发态走 vite proxy（/api → 4173），生产态同源，故 base URL 都是相对 ''。
import type {
  ProjectsResponse, ProjectEntry, AddProjectBody, ProjectModel, ApiError,
  ConfigScope, KnownExecutor, AgentProfile, ProviderConfig, ScannedAgent,
  FlowGraph, FlowEntry, FlowAnalysis,
} from './types'

export class HttpError extends Error {
  status: number
  body: ApiError
  constructor(status: number, body: ApiError) {
    super(body.error || body.message || `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const parsed = text ? JSON.parse(text) : {}
  if (!res.ok) throw new HttpError(res.status, parsed as ApiError)
  return parsed as T
}

export const api = {
  listProjects: () => request<ProjectsResponse>('GET', '/api/projects'),
  addProject: (body: AddProjectBody) =>
    request<{ project: ProjectEntry }>('POST', '/api/projects', body),
  removeProject: (id: string) =>
    request<{ ok: boolean; id: string }>('DELETE', `/api/projects/${encodeURIComponent(id)}`),
  renameProject: (id: string, name: string) =>
    request<{ project: ProjectEntry }>('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name }),
  touchProject: (id: string) =>
    request<{ project: ProjectEntry }>('PATCH', `/api/projects/${encodeURIComponent(id)}`, { touch: true }),
  getModel: (id: string) =>
    request<ProjectModel>('GET', `/api/projects/${encodeURIComponent(id)}/model`),
  health: () => request<{ ok: boolean }>('GET', '/api/health'),

  // ── config（agent/provider 配置读写）──
  listExecutors: () =>
    request<{ executors: KnownExecutor[] }>('GET', '/api/config/executors'),
  scanAgents: () =>
    request<{ agents: ScannedAgent[] }>('GET', '/api/config/scan'),
  getConfigAgents: (scope: ConfigScope, repo?: string) =>
    request<{ agents: Record<string, AgentProfile> }>('GET', `/api/config/agents?scope=${scope}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`),
  saveConfigAgent: (name: string, profile: AgentProfile, scope: ConfigScope, repo?: string) =>
    request<{ name: string; profile: AgentProfile }>('PUT', `/api/config/agents/${encodeURIComponent(name)}?scope=${scope}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`, { profile }),
  deleteConfigAgent: (name: string, scope: ConfigScope, repo?: string) =>
    request<{ name: string; deleted: boolean }>('DELETE', `/api/config/agents/${encodeURIComponent(name)}?scope=${scope}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`),
  getConfigProviders: (scope: ConfigScope, repo?: string) =>
    request<{ providers: Record<string, ProviderConfig> }>('GET', `/api/config/providers?scope=${scope}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`),
  saveConfigProvider: (name: string, provider: ProviderConfig, scope: ConfigScope, repo?: string) =>
    request<{ name: string; provider: ProviderConfig }>('PUT', `/api/config/providers/${encodeURIComponent(name)}?scope=${scope}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`, { provider }),
  deleteConfigProvider: (name: string, scope: ConfigScope, repo?: string) =>
    request<{ name: string; deleted: boolean }>('DELETE', `/api/config/providers/${encodeURIComponent(name)}?scope=${scope}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`),

  // ── flow 可视化 ──
  listFlows: () =>
    request<{ flows: Array<FlowEntry & { projectName: string | null; projectPath?: string }> }>('GET', '/api/flows/list'),
  analyzeFlow: (file: string) =>
    request<FlowAnalysis>('GET', `/api/flows/analyze?file=${encodeURIComponent(file)}`),
  visualizeFlow: (file: string, repo?: string) =>
    request<FlowGraph>('GET', `/api/flows/viz?file=${encodeURIComponent(file)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`),
}
