// RunsView — 运行列表（树形）+ 过滤 + 详情面板。
//
// 迁移自 dashboard/render.js 的 Runs tab。数据消费完全对齐 collect.js 产出的 model。
// 布局：左侧 run 列表（含状态/文本过滤），右侧选中 run 的详情（steps/events/logs/signals/children）。
import { useState, useMemo } from 'react'
import type { ProjectModel, Run, DisplayStatus } from '../types'
import {
  StatusBadge, timeAgo, timeAbs,
} from '../components/ui'
import { RunDetail } from '../components/RunDetail'

type StatusFilter = Set<DisplayStatus>
const STATUS_ORDER: DisplayStatus[] = ['running', 'stale', 'paused', 'completed', 'unknown']

export default function RunsView({ model }: { model: ProjectModel }) {
  const byId = useMemo(() => {
    const m = new Map<string, Run>()
    for (const r of model.runs) m.set(r.runId, r)
    return m
  }, [model.runs])

  const [selected, setSelected] = useState<string | null>(model.runs[0]?.runId ?? null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(new Set())
  const [search, setSearch] = useState('')

  const toggleStatus = (s: DisplayStatus) => {
    setStatusFilter(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  const matchFilter = (r: Run): boolean => {
    if (statusFilter.size && !statusFilter.has(r.displayStatus)) return false
    if (search) {
      const q = search.toLowerCase()
      return r.runId.toLowerCase().includes(q)
        || (r.feature ?? '').toLowerCase().includes(q)
        || (r.flowName ?? '').toLowerCase().includes(q)
    }
    return true
  }

  // 树形列表：根在前、子紧随；被筛掉的根仍显示其匹配的子。
  const rows: { run: Run; isChild: boolean }[] = useMemo(() => {
    const out: { run: Run; isChild: boolean }[] = []
    const shown = new Set<string>()
    const roots = model.runs.filter(r => !r.parentId)
    for (const root of roots) {
      const kids = (root.children ?? []).map(id => byId.get(id)).filter(Boolean) as Run[]
      const rootMatch = matchFilter(root)
      const kidMatches = kids.filter(matchFilter)
      if (!rootMatch && kidMatches.length === 0) continue
      out.push({ run: root, isChild: false })
      shown.add(root.runId)
      for (const k of kids) {
        if (matchFilter(k) || rootMatch) {
          out.push({ run: k, isChild: true })
          shown.add(k.runId)
        }
      }
    }
    // 孤儿（未在树中覆盖的）
    for (const r of model.runs) {
      if (!shown.has(r.runId) && matchFilter(r)) out.push({ run: r, isChild: false })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.runs, byId, statusFilter, search])

  const selectedRun = selected ? byId.get(selected) ?? null : null

  if (model.runs.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">🏃</div>
        <p>该项目还没有任何 run。</p>
        <p className="muted">跑一个试试：<code>flowcast orchestrate "&lt;需求&gt;" --repo .</code></p>
      </div>
    )
  }

  return (
    <div className="runs-layout">
      {/* 左：列表 + 过滤 */}
      <div className="runs-list-pane">
        <div className="runs-filters">
          <input
            type="search"
            placeholder="搜索 runId / feature / flow…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="runs-search"
          />
          <div className="status-chips">
            {STATUS_ORDER.map(s => {
              const count = model.runs.filter(r => r.displayStatus === s).length
              if (count === 0) return null
              return (
                <button
                  key={s}
                  className={`status-chip ${statusFilter.has(s) ? 'active' : ''} ${s}`}
                  onClick={() => toggleStatus(s)}
                >
                  {s} <span className="chip-count">{count}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="run-list">
          {rows.length === 0 ? (
            <div className="empty" style={{ margin: '20px 0' }}>无匹配 run</div>
          ) : rows.map(({ run, isChild }) => (
            <RunRow
              key={run.runId}
              run={run}
              isChild={isChild}
              selected={selected === run.runId}
              onClick={() => setSelected(run.runId)}
            />
          ))}
        </div>
      </div>

      {/* 右：详情 */}
      <div className="runs-detail-pane">
        {selectedRun ? <RunDetail run={selectedRun} byId={byId} onSelect={setSelected} /> : (
          <div className="empty" style={{ margin: '40px 0' }}>
            <div className="empty-icon">👈</div>
            <p>选择左侧的一个 run 查看详情</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Run 列表行 ───────────────────────────────────────────────────
function RunRow({ run, isChild, selected, onClick }: {
  run: Run
  isChild: boolean
  selected: boolean
  onClick: () => void
}) {
  return (
    <div
      className={`run-row ${isChild ? 'is-child' : ''} ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="run-rid mono">{run.runId}</div>
      <div className="run-meta">
        <StatusBadge status={run.displayStatus} />
        {run.flowName && <span className="run-tag mono">{run.flowName}</span>}
        {run.feature && <span className="run-feature">{run.feature}</span>}
        <span className="run-steps">{run.completedCount} steps</span>
        {run.skippedCount > 0 && <span className="faint">+{run.skippedCount}↩</span>}
        {run.signals.fallback > 0 && <span title="fallback">↻{run.signals.fallback}</span>}
        {run.signals.gateFail > 0 && <span className="run-warn" title="质量门红灯">✗gate</span>}
        {run.children && run.children.length > 0 && <span className="faint">[{run.children.length} 子]</span>}
        <span className="faint run-time" title={timeAbs(run.lastActivity)}>
          {timeAgo(run.lastActivity)}
        </span>
      </div>
    </div>
  )
}
