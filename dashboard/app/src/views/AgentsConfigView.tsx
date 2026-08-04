// AgentsConfigView — 全局 Agent 配置页（/agents）。
//
// 查看 + 编辑 用户级 / 项目级的 agents.json 和 providers.json。
// 安全约束：apiKey 永远是 ${ENV_VAR} 引用，表单只接受环境变量名，不接受明文密钥。
import { useEffect, useState, useCallback } from 'react'
import { api, HttpError } from '../api'
import type {
  ConfigScope, KnownExecutor, AgentProfile, ProviderConfig, ScannedAgent, ProjectEntry,
} from '../types'
import { Loading, ErrorBox } from '../components/ui'
import { AgentEditDialog, ProviderEditDialog } from '../components/ConfigEdit'

export default function AgentsConfigView() {
  const [scope, setScope] = useState<ConfigScope>('user')
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>(undefined)
  const [agents, setAgents] = useState<Record<string, AgentProfile> | null>(null)
  const [providers, setProviders] = useState<Record<string, ProviderConfig> | null>(null)
  const [executors, setExecutors] = useState<KnownExecutor[]>([])
  const [scanned, setScanned] = useState<ScannedAgent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<
    | { type: 'agent'; name?: string; profile?: AgentProfile }
    | { type: 'provider'; name?: string; provider?: ProviderConfig }
    | null
  >(null)

  // 加载项目列表（用于 project scope 选择器）
  useEffect(() => {
    api.listProjects().then(({ projects }) => setProjects(projects)).catch(() => {})
  }, [])

  // 加载元数据（executors + scan），只加载一次
  useEffect(() => {
    Promise.all([api.listExecutors(), api.scanAgents()])
      .then(([{ executors }, { agents }]) => {
        setExecutors(executors)
        setScanned(agents)
      })
      .catch(e => setError(e instanceof HttpError ? e.body.error : String(e)))
  }, [])

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [a, p] = await Promise.all([
        api.getConfigAgents(scope, selectedRepo),
        api.getConfigProviders(scope, selectedRepo),
      ])
      setAgents(a.agents)
      setProviders(p.providers)
    } catch (e) {
      setError(e instanceof HttpError ? e.body.error : String(e))
      setAgents({})
      setProviders({})
    }
  }, [scope, selectedRepo])

  useEffect(() => { reload() }, [reload])

  const scanByCli = new Map(scanned.map(s => [s.cli, s]))

  return (
    <div className="col">
      <div className="spread">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>Agent 配置</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            管理 agent profile 和 LLM provider。API key 永远是 <code>{'${ENV_VAR}'}</code> 引用，不接受明文。
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload}>↻ 刷新</button>
      </div>

      {/* scope 切换 */}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button
          className={`btn btn-sm ${scope === 'user' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => { setScope('user'); setSelectedRepo(undefined) }}
        >
          用户级 (~/.flowcast)
        </button>
        <button
          className={`btn btn-sm ${scope === 'project' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setScope('project')}
        >
          项目级
        </button>
        {scope === 'project' && (
          <select
            value={selectedRepo ?? ''}
            onChange={e => setSelectedRepo(e.target.value || undefined)}
            style={{ width: 'auto', minWidth: 200 }}
          >
            <option value="">选择项目…</option>
            {projects.map(p => (
              <option key={p.id} value={p.path}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      {scope === 'project' && !selectedRepo ? (
        <div className="empty"><div className="empty-icon">📁</div><p>请在上方选择一个项目</p></div>
      ) : agents === null || providers === null ? (
        <Loading label="加载配置…" />
      ) : (
        <>
          {/* ── Agents ── */}
          <div className="config-section">
            <div className="spread">
              <h3 className="section-title" style={{ margin: 0 }}>Agents（{Object.keys(agents).length}）</h3>
              <button className="btn btn-primary btn-sm" onClick={() => setEditing({ type: 'agent' })}>
                + 新增 agent
              </button>
            </div>
            <div className="config-list">
              {Object.keys(agents).length === 0 ? (
                <div className="muted" style={{ padding: '12px 0' }}>还没有 agent profile</div>
              ) : Object.entries(agents).map(([name, profile]) => (
                <AgentRow
                  key={name}
                  name={name}
                  profile={profile}
                  scan={scanByCli.get(profile.executor)}
                  onEdit={() => setEditing({ type: 'agent', name, profile })}
                  onDelete={async () => {
                    if (!confirm(`删除 agent「${name}」？`)) return
                    try {
                      await api.deleteConfigAgent(name, scope, selectedRepo)
                      reload()
                    } catch (e) { alert(`删除失败：${e instanceof HttpError ? e.body.error : String(e)}`) }
                  }}
                />
              ))}
            </div>
          </div>

          {/* ── Providers ── */}
          <div className="config-section">
            <div className="spread">
              <h3 className="section-title" style={{ margin: 0 }}>Providers（{Object.keys(providers).length}）</h3>
              <button className="btn btn-primary btn-sm" onClick={() => setEditing({ type: 'provider' })}>
                + 新增 provider
              </button>
            </div>
            <div className="config-list">
              {Object.keys(providers).length === 0 ? (
                <div className="muted" style={{ padding: '12px 0' }}>还没有 provider</div>
              ) : Object.entries(providers).map(([name, provider]) => (
                <ProviderRow
                  key={name}
                  name={name}
                  provider={provider}
                  onEdit={() => setEditing({ type: 'provider', name, provider })}
                  onDelete={async () => {
                    if (!confirm(`删除 provider「${name}」？`)) return
                    try {
                      await api.deleteConfigProvider(name, scope, selectedRepo)
                      reload()
                    } catch (e) { alert(`删除失败：${e instanceof HttpError ? e.body.error : String(e)}`) }
                  }}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {editing?.type === 'agent' && (
        <AgentEditDialog
          name={editing.name}
          initial={editing.profile}
          executors={executors}
          providers={providers ?? {}}
          scope={scope}
          repo={selectedRepo}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
      {editing?.type === 'provider' && (
        <ProviderEditDialog
          name={editing.name}
          initial={editing.provider}
          scope={scope}
          repo={selectedRepo}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
    </div>
  )
}

// ── Agent 列表行 ─────────────────────────────────────────────────
function AgentRow({ name, profile, scan, onEdit, onDelete }: {
  name: string
  profile: AgentProfile
  scan?: ScannedAgent
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="card config-card">
      <div className="spread">
        <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong className="mono">{name}</strong>
            <span className="badge badge-unknown" style={{ fontSize: 10 }}>{profile.executor}</span>
            {profile.provider && <span className="faint mono">→ {profile.provider}</span>}
          </div>
          <div className="row" style={{ gap: 10, fontSize: 11, flexWrap: 'wrap' }}>
            {scan ? (
              <>
                <span style={{ color: scan.installed ? 'var(--st-completed)' : 'var(--st-failed)' }}>
                  {scan.installed ? '✓已装' : '✗未装'}
                </span>
                {scan.authed !== null && (
                  <span style={{ color: scan.authed ? 'var(--st-completed)' : 'var(--st-failed)' }}>
                    {scan.authed ? '✓已授权' : '✗未授权'}
                  </span>
                )}
              </>
            ) : (
              <span className="faint">（自定义 executor）</span>
            )}
            {profile.model && <span className="faint mono">{profile.model}</span>}
            {profile.timeout && <span className="faint">{Math.round(profile.timeout / 1000 / 60)}min</span>}
            {profile.maxSteps && <span className="faint">{profile.maxSteps} steps</span>}
          </div>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>编辑</button>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--st-failed)' }} onClick={onDelete}>删除</button>
        </div>
      </div>
    </div>
  )
}

// ── Provider 列表行 ──────────────────────────────────────────────
function ProviderRow({ name, provider, onEdit, onDelete }: {
  name: string
  provider: ProviderConfig
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className="card config-card">
      <div className="spread">
        <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong className="mono">{name}</strong>
            {provider.type && <span className="badge badge-unknown" style={{ fontSize: 10 }}>{provider.type}</span>}
          </div>
          <div className="row" style={{ gap: 10, fontSize: 11, flexWrap: 'wrap' }} title={provider.apiBase}>
            {provider.model && <span className="faint mono">{provider.model}</span>}
            {provider._envVar && (
              <span style={{ color: provider._envSet ? 'var(--st-completed)' : 'var(--st-failed)' }}>
                {provider._envSet ? '✓' : '✗'} ${provider._envVar}
              </span>
            )}
            {provider.apiBase && <span className="faint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>{provider.apiBase}</span>}
          </div>
        </div>
        <div className="row gap-sm">
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>编辑</button>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--st-failed)' }} onClick={onDelete}>删除</button>
        </div>
      </div>
    </div>
  )
}
