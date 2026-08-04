// ProjectView — 单项目详情（三 tab）。
//
// 路由 /project/:id → 拉取该项目 model → 顶部项目信息条 + tab 切换。
// tab：Runs（默认）/ Agents / Workflows。进入即 touchProject（更新最近使用）。
import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, HttpError } from '../api'
import type { ProjectModel } from '../types'
import { Loading, ErrorBox, timeAbs } from '../components/ui'
import RunsView from './RunsView'
import AgentsView from './AgentsView'
import WorkflowsView from './WorkflowsView'

type Tab = 'runs' | 'agents' | 'workflows'

export default function ProjectView() {
  const { id } = useParams<{ id: string }>()
  const [model, setModel] = useState<ProjectModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('runs')

  const reload = useCallback(async () => {
    if (!id) return
    setLoading(true); setError(null)
    try {
      // touch + getModel 并行：touch 更新最近使用，getModel 取展示数据
      const [m] = await Promise.all([
        api.getModel(id),
        api.touchProject(id).catch(() => null),  // touch 失败不影响展示
      ])
      setModel(m)
    } catch (e) {
      setError(e instanceof HttpError ? e.body.error : String(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { reload() }, [reload])

  if (loading && !model) return <Loading label="加载项目数据…" />
  if (error) return (
    <div className="col">
      <Link to="/" className="muted">← 返回项目列表</Link>
      <ErrorBox message={error} />
    </div>
  )
  if (!model) return null

  return (
    <div className="col">
      <div className="spread">
        <div className="col" style={{ gap: 4 }}>
          <Link to="/" className="muted" style={{ fontSize: 12 }}>← 返回项目列表</Link>
          <div className="row" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>{model.repo.split('/').pop()}</h2>
            {model._collectWarning && (
              <span className="faint" style={{ fontSize: 12 }} title={model._collectWarning}>
                ⚠️ {model._collectWarning}
              </span>
            )}
          </div>
          <div className="mono muted" style={{ fontSize: 12 }} title={model.repo}>
            {model.repo}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={reload} disabled={loading}>
          {loading ? <><span className="spinner" /> 刷新中</> : '↻ 刷新'}
        </button>
      </div>

      <StatBar model={model} />

      <div className="tabs">
        <button className={`tab ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
          Runs <span className="tab-count">{model.stats.total}</span>
        </button>
        <button className={`tab ${tab === 'agents' ? 'active' : ''}`} onClick={() => setTab('agents')}>
          Agents <span className="tab-count">{model.agents.length}</span>
        </button>
        <button className={`tab ${tab === 'workflows' ? 'active' : ''}`} onClick={() => setTab('workflows')}>
          Workflows <span className="tab-count">{model.workflows.all.length}</span>
        </button>
      </div>

      <div className="tab-body">
        {tab === 'runs' && <RunsView model={model} />}
        {tab === 'agents' && <AgentsView agents={model.agents} />}
        {tab === 'workflows' && <WorkflowsView model={model} />}
      </div>
    </div>
  )
}

// ── 顶部 stat 条 ─────────────────────────────────────────────────
function StatBar({ model }: { model: ProjectModel }) {
  const s = model.stats
  const allItems: Array<[string, number, string?]> = [
    ['总计', s.total],
    ['运行中', s.running, 'running'],
    ['僵尸', s.stale, 'stale'],
    ['暂停', s.paused, 'paused'],
    ['完成', s.completed, 'completed'],
  ]
  const items = allItems.filter((it) => it[1] > 0)

  return (
    <div className="statbar card">
      {items.map(([label, n, tone]) => (
        <div key={label} className={`statbar-item ${tone ? `tone-${tone}` : ''}`}>
          <span className="statbar-value">{n}</span>
          <span className="statbar-label">{label}</span>
        </div>
      ))}
      {s.fallback > 0 && (
        <div className="statbar-item"><span className="statbar-value">{s.fallback}</span><span className="statbar-label">fallback</span></div>
      )}
      {s.gateFail > 0 && (
        <div className="statbar-item tone-failed"><span className="statbar-value">{s.gateFail}</span><span className="statbar-label">质量门红灯</span></div>
      )}
      {s.skipped > 0 && (
        <div className="statbar-item"><span className="statbar-value">{s.skipped}</span><span className="statbar-label">跳过</span></div>
      )}
      {s.totalTokens > 0 && (
        <div className="statbar-item"><span className="statbar-value">{formatTok(s.totalTokens)}</span><span className="statbar-label">tokens</span></div>
      )}
      <div className="statbar-item faint" style={{ marginLeft: 'auto' }}>
        <span className="statbar-label">快照时间</span>
        <span className="statbar-value" style={{ fontSize: 13 }} title={timeAbs(model.generatedAt)}>
          {new Date(model.generatedAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}

function formatTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
