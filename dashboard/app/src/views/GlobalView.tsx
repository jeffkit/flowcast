// GlobalView — 全局聚合入口。
//
// 展示用户登记的全部 flowcast 项目：卡片网格（每张含该项目汇总 stats）+
// 「添加项目」按钮（弹窗输入路径）。
//
// 数据获取：GET /api/projects 一次性返回所有项目 + 每项内联轻量 summary（只含 stats）。
// 不再为每张卡片单独拉完整 model（某个大项目 model 可达数 MB，N 次请求会卡死页面）。
import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api, HttpError } from '../api'
import type { ProjectsResponse } from '../types'
import { Loading, ErrorBox, timeAgo, timeAbs, formatTokens } from '../components/ui'

type ProjectListItem = ProjectsResponse['projects'][number]

export default function GlobalView() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const { projects } = await api.listProjects()
      setProjects(projects)
    } catch (e) {
      setError(e instanceof HttpError ? e.body.error : String(e))
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  // 窗口重新聚焦 / 页面恢复可见时自动刷新：
  // 覆盖「在别处（CLI / 另一标签页）登记了项目，切回来要手动刷新」的体验缺陷。
  // 无轮询、无 WebSocket，仅在用户真正回到本页时触发一次轻量拉取。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [reload])

  return (
    <div className="col">
      <div className="spread">
        <div>
          <h2 style={{ margin: '0 0 4px' }}>项目</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            登记使用 flowcast 的项目目录，查看各自的运行历史。
          </div>
        </div>
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={reload}>↻ 刷新</button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ 添加项目</button>
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      {projects === null && !error ? (
        <Loading label="加载项目列表…" />
      ) : projects && projects.length === 0 ? (
        <EmptyState onAdd={() => setShowAdd(true)} />
      ) : projects ? (
        <div className="project-grid">
          {projects.map(p => <ProjectCard key={p.id} project={p} onChanged={reload} />)}
        </div>
      ) : null}

      {showAdd && (
        <AddProjectDialog
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); reload() }}
        />
      )}
    </div>
  )
}

// ── 项目卡片 ─────────────────────────────────────────────────────
// summary 由列表接口内联返回，无需卡片自己再发请求。
function ProjectCard({ project, onChanged }: { project: ProjectListItem; onChanged: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const stats = project.summary?.stats ?? null

  return (
    <div className="card project-card">
      <div className="spread">
        <Link to={`/project/${project.id}`} className="project-name">
          {project.name}
        </Link>
        <div className="row" style={{ position: 'relative' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setMenuOpen(v => !v)}>⋮</button>
          {menuOpen && (
            <>
              <div className="menu-overlay" onClick={() => setMenuOpen(false)} />
              <div className="menu">
                <button className="menu-item" onClick={() => { setRenaming(true); setMenuOpen(false) }}>
                  ✏️ 改名
                </button>
                <button className="menu-item danger" onClick={() => handleRemove(project, onChanged)}>
                  🗑 移除
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="muted mono project-path" title={project.path}>{project.path}</div>

      <div className="project-stats">
        {project.summaryError ? (
          <span className="faint" title={project.summaryError}>stats 采集失败</span>
        ) : !stats ? (
          <span className="faint">（无数据）</span>
        ) : (
          <>
            <StatChip label="总计" value={stats.total} />
            {stats.running > 0 && <StatChip label="运行" value={stats.running} tone="running" />}
            {stats.stale > 0 && <StatChip label="僵尸" value={stats.stale} tone="stale" />}
            {stats.paused > 0 && <StatChip label="暂停" value={stats.paused} tone="paused" />}
            {stats.completed > 0 && <StatChip label="完成" value={stats.completed} tone="completed" />}
            {stats.totalTokens > 0 && (
              <span className="stat-chip" title="总 token 消耗">🔢 {formatTokens(stats.totalTokens)}</span>
            )}
          </>
        )}
      </div>

      <div className="faint project-footer">
        最近查看：<span title={timeAbs(project.lastOpenedAt)}>{timeAgo(project.lastOpenedAt)}</span>
      </div>

      {renaming && (
        <RenameDialog
          project={project}
          onClose={() => setRenaming(false)}
          onDone={() => { setRenaming(false); onChanged() }}
        />
      )}
    </div>
  )
}

function StatChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const cls = tone ? `stat-chip stat-${tone}` : 'stat-chip'
  return <span className={cls}>{label} <strong>{value}</strong></span>
}

async function handleRemove(project: ProjectListItem, onChanged: () => void) {
  if (!confirm(`移除项目「${project.name}」？\n（只从登记薄移除，不删除磁盘上的 run 数据）`)) return
  try {
    await api.removeProject(project.id)
    onChanged()
  } catch (e) {
    alert(`移除失败：${e instanceof HttpError ? e.body.error : String(e)}`)
  }
}

// ── 添加项目弹窗 ─────────────────────────────────────────────────
function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (!path.trim()) { setErr('请输入项目路径'); return }
    setBusy(true); setErr(null)
    try {
      await api.addProject({ path: path.trim(), name: name.trim() || undefined })
      onAdded()
    } catch (e) {
      if (e instanceof HttpError) {
        const b = e.body
        if (e.status === 409 && b.existingId) {
          setErr(`该项目已登记（id: ${b.existingId}）`)
        } else {
          setErr(b.error || b.message || `添加失败 (HTTP ${e.status})`)
        }
      } else {
        setErr(String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="添加项目" onClose={onClose}>
      <div className="col">
        <label className="muted">项目目录绝对路径</label>
        <input
          type="text"
          placeholder="/Users/me/projects/my-service"
          value={path}
          onChange={e => setPath(e.target.value)}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
        />
        <div className="faint" style={{ fontSize: 12, marginTop: -4 }}>
          目录下需含 <code>.flowcast/</code> 或 <code>.flowx/</code>
        </div>

        <label className="muted">显示名（可选）</label>
        <input
          type="text"
          placeholder="默认取目录名"
          value={name}
          onChange={e => setName(e.target.value)}
        />

        {err && <div style={{ color: 'var(--st-failed)', fontSize: 13 }}>⚠️ {err}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <><span className="spinner" /> 添加中…</> : '添加'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

// ── 改名弹窗 ─────────────────────────────────────────────────────
function RenameDialog({ project, onClose, onDone }: {
  project: ProjectListItem; onClose: () => void; onDone: () => void
}) {
  const [name, setName] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await api.renameProject(project.id, name.trim())
      onDone()
    } catch (e) {
      setErr(e instanceof HttpError ? e.body.error : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="改名" onClose={onClose}>
      <div className="col">
        <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        {err && <div style={{ color: 'var(--st-failed)', fontSize: 13 }}>⚠️ {err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>保存</button>
        </div>
      </div>
    </Dialog>
  )
}

// ── 弹窗通用容器 ─────────────────────────────────────────────────
function Dialog({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void
}) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog card" onClick={e => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── 空态 ─────────────────────────────────────────────────────────
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon">📂</div>
      <h3>还没有登记任何项目</h3>
      <p className="muted">添加一个含 <code>.flowcast/</code> 目录的项目，开始查看它的运行历史。</p>
      <button className="btn btn-primary" onClick={onAdd} style={{ marginTop: 8 }}>+ 添加项目</button>
    </div>
  )
}
