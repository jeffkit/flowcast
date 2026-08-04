// 通用小组件 + 格式化工具。
import type { DisplayStatus } from '../types'

// 状态徽章（displayStatus → 对应 badge class）
export function StatusBadge({ status }: { status: DisplayStatus | string }) {
  const cls = `badge badge-${status}`
  return <span className={cls}>{status}</span>
}

// 时间相对格式化：「3 分钟前」「2 小时前」「昨天」；超 7 天回退到绝对时间。
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '-'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '-'
  const diff = Date.now() - t
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  return new Date(t).toLocaleDateString()
}

// 绝对时间（用于 hover title）
export function timeAbs(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString()
}

// 持续时间格式化：ms → 「1m 23s」/「42s」/「1h 5m」
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '-'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rs = s % 60
    return rs ? `${m}m ${rs}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

// token 数字格式化：1234 → 1.2k；1500000 → 1.5M
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !n) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// 加载占位
export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="row muted" style={{ padding: '8px 0' }}>
      <span className="spinner" /> {label}
    </div>
  )
}

// 错误展示
export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="card" style={{ borderColor: 'var(--st-failed)', color: 'var(--st-failed)' }}>
      ⚠️ {message}
    </div>
  )
}
