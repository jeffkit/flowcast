// WorkflowsView — flow 文件清单 + byWorkflow run 统计交叉。
import type { ProjectModel, FlowEntry, WorkflowGroup } from '../types'
import { timeAgo, timeAbs, formatTokens } from '../components/ui'

export default function WorkflowsView({ model }: { model: ProjectModel }) {
  const { workflows, byWorkflow } = model

  if (workflows.all.length === 0 && Object.keys(byWorkflow).length === 0) {
    return <div className="empty"><div className="empty-icon">📜</div><p>无 flow 文件</p></div>
  }

  return (
    <div className="col">
      <FlowSection title="项目级 flow" entries={workflows.project} byWorkflow={byWorkflow} emptyHint="无项目级 flow（.flowcast/flows/）" />
      <FlowSection title="用户级 flow" entries={workflows.user} byWorkflow={byWorkflow} emptyHint="无用户级 flow（~/.flowcast/flows/）" />
      <OrphanGroups workflows={workflows.all} byWorkflow={byWorkflow} />
    </div>
  )
}

function FlowSection({ title, entries, byWorkflow, emptyHint }: {
  title: string
  entries: FlowEntry[]
  byWorkflow: Record<string, WorkflowGroup>
  emptyHint: string
}) {
  return (
    <div className="col">
      <h3 className="section-title">{title}</h3>
      {entries.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>{emptyHint}</div>
      ) : (
        <div className="card-list">
          {entries.map(f => {
            const g = byWorkflow[f.name]
            return (
              <div key={f.path} className="card-list-row">
                <div className="col" style={{ gap: 2, flex: 1 }}>
                  <span className="mono">{f.name}</span>
                  <span className="faint mono" style={{ fontSize: 11 }}>{f.path}</span>
                </div>
                {g ? (
                  <div className="row" style={{ gap: 10, fontSize: 12 }}>
                    <span className="muted">runs <strong style={{ color: 'var(--text)' }}>{g.total}</strong></span>
                    {g.running > 0 && <span className="stat-running">运行 {g.running}</span>}
                    {g.stale > 0 && <span className="stat-stale">僵尸 {g.stale}</span>}
                    {g.completed > 0 && <span className="stat-completed">完成 {g.completed}</span>}
                    {g.totalTokens > 0 && <span className="muted">🔢 {formatTokens(g.totalTokens)}</span>}
                    {g.lastActivityMs && (
                      <span className="faint" title={timeAbs(new Date(g.lastActivityMs).toISOString())}>
                        {timeAgo(new Date(g.lastActivityMs).toISOString())}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="faint" style={{ fontSize: 12 }}>尚无运行记录</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// byWorkflow 里有、但 workflows.all 里没有的「孤儿」组（flow 文件可能被删/改名）
function OrphanGroups({ workflows, byWorkflow }: {
  workflows: FlowEntry[]
  byWorkflow: Record<string, WorkflowGroup>
}) {
  const known = new Set(workflows.map(f => f.name))
  const orphans = Object.values(byWorkflow).filter(g => g.flowName !== '(unknown)' && !known.has(g.flowName))
  if (orphans.length === 0) return null
  return (
    <div className="col">
      <h3 className="section-title">孤儿运行组（flow 文件已不在）</h3>
      <div className="card-list">
        {orphans.map(g => (
          <div key={g.flowName} className="card-list-row">
            <span className="mono">{g.flowName}</span>
            <span className="muted">runs <strong style={{ color: 'var(--text)' }}>{g.total}</strong></span>
          </div>
        ))}
      </div>
    </div>
  )
}
