// AgentsView — agent profile 装机/凭证状态表（迁移自 render.js Agents tab）。
import type { Agent } from '../types'

export default function AgentsView({ agents }: { agents: Agent[] }) {
  if (!agents || agents.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">🤖</div>
        <p>未发现任何 agent 配置。</p>
        <p className="muted">提示：<code>flowcast init</code> 可扫描并生成本机 agent 配置。</p>
      </div>
    )
  }

  return (
    <div className="card">
      <table className="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>CLI</th>
            <th>模型</th>
            <th>Provider</th>
            <th>配置</th>
            <th>已装</th>
            <th>已授权</th>
            <th>就绪</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(a => (
            <tr key={a.name}>
              <td>{a.name}</td>
              <td className="mono">{a.executor ?? '-'}</td>
              <td className="mono">{a.model ?? '-'}</td>
              <td className="mono">{a.provider ?? '-'}</td>
              <td><YesNo on={a.configured} /></td>
              <td><YesNo on={a.installed} /></td>
              <td><AuthBadge authed={a.authed} detail={a.authDetail} /></td>
              <td><ReadyDot ready={a.ready} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function YesNo({ on }: { on: boolean }) {
  return <span style={{ color: on ? 'var(--st-completed)' : 'var(--text-faint)' }}>{on ? '✓' : '✗'}</span>
}

function AuthBadge({ authed, detail }: { authed: boolean | null; detail: string | null }) {
  if (authed === null) return <span className="faint" title={detail ?? ''}>未知</span>
  if (authed) return <span style={{ color: 'var(--st-completed)' }} title={detail ?? ''}>✓</span>
  return <span style={{ color: 'var(--st-failed)' }} title={detail ?? ''}>✗</span>
}

function ReadyDot({ ready }: { ready: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 9, height: 9, borderRadius: '50%',
        background: ready ? 'var(--st-completed)' : 'var(--st-failed)',
      }}
      title={ready ? '就绪' : '未就绪'}
    />
  )
}
