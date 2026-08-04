// RunDetail — 单个 run 的详情面板。
//
// 迁移自 dashboard/render.js 的 renderDetail()。包含：
//   header（runId + 状态）、僵尸/暂停告警、KV 元数据、signals、限流详情、
//   子 run 网格、步骤时间线（可展开）、事件表、日志尾部。
import { useState } from 'react'
import type { Run, Step, ErrorStep, SkippedStep, RunEvent } from '../types'
import {
  StatusBadge, timeAbs, formatDuration, formatTokens,
} from './ui'

interface ById { get(id: string): Run | undefined }

export function RunDetail({ run, byId, onSelect }: {
  run: Run
  byId: ById
  onSelect: (id: string) => void
}) {
  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <h2 className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>
          {run.runId}
        </h2>
        <StatusBadge status={run.displayStatus} />
      </div>
      <div className="mono faint" style={{ fontSize: 11, wordBreak: 'break-all' }}>{run.dir}</div>

      {run.stale && (
        <div className="alert alert-warn">
          ⚠ 僵尸 run：status=running 但最近活动 {timeAbs(run.lastActivity)} 已超阈值，进程可能已崩溃/被 kill
        </div>
      )}
      {run.paused && run.pauseReason && (
        <div className="alert alert-info">⏸ 暂停等人工：{run.pauseReason}</div>
      )}

      <RunMeta run={run} />

      <RunSignals run={run} />

      <ChildRuns run={run} byId={byId} onSelect={onSelect} />

      <StepTimeline run={run} />

      <EventsTable events={run.events} />

      <LogTails run={run} />
    </div>
  )
}

// ── KV 元数据 ────────────────────────────────────────────────────
function RunMeta({ run }: { run: Run }) {
  const u = run.usage
  const items: Array<[string, string]> = [
    ['feature', run.feature ?? '-'],
    ['开始', timeAbs(run.startedAt) || '-'],
    ['耗时', formatDuration(run.durationMs)],
    ['最近活动', timeAbs(run.lastActivity)],
    ['完成步骤', String(run.completedCount)],
  ]
  if (run.currentStep) items.push(['当前步', run.currentStep])
  if (run.models && run.models.length) items.push(['模型', run.models.join(', ')])
  if (u.hasTokens) {
    items.push([
      'Token (入/出)',
      `${formatTokens(u.inputTokens)} / ${formatTokens(u.outputTokens)} = ${formatTokens(u.totalTokens)}`,
    ])
  }
  if (run.childUsage) {
    items.push([
      '子run Token',
      `${formatTokens(run.childUsage.totalTokens)}`,
    ])
  }
  return (
    <div className="kv-grid">
      {items.map(([k, v]) => (
        <div key={k} className="kv-item">
          <span className="kv-key">{k}</span>
          <span className="kv-val mono">{v}</span>
        </div>
      ))}
    </div>
  )
}

// ── Signals chip 组 ──────────────────────────────────────────────
function RunSignals({ run }: { run: Run }) {
  const sg = run.signals
  const chips: React.ReactNode[] = []
  if (sg.fallback) {
    const detail = Object.entries(sg.fallbackByScope ?? {}).map(([s, n]) => `${s}:${n}`).join(' ')
    chips.push(
      <span key="fb" className="sig-chip warn" title={detail}>
        <b>{sg.fallback}</b>fallback
      </span>,
    )
  }
  if (sg.gateFail) chips.push(<span key="gf" className="sig-chip err"><b>{sg.gateFail}</b>质量门红灯</span>)
  if (sg.gatePass) chips.push(<span key="gp" className="sig-chip ok"><b>{sg.gatePass}</b>质量门通过</span>)
  if (sg.fixRounds) chips.push(<span key="fr" className="sig-chip warn"><b>{sg.fixRounds}</b>fix 轮</span>)
  if (sg.group.done || sg.group.failed) {
    chips.push(<span key="g" className="sig-chip"><b>{sg.group.done}/{sg.group.done + sg.group.failed}</b>组完成</span>)
  }
  const rlEntries = Object.entries(sg.rateLimits ?? {})
  if (rlEntries.length) {
    const now = Date.now()
    const active = rlEntries.filter(([, e]) => e.availableAt > now)
    if (active.length) {
      const detail = active.map(([k, e]) => `${k} 可用 ${timeAbs(new Date(e.availableAt).toISOString())}`).join('\n')
      chips.push(<span key="rl" className="sig-chip err" title={detail}><b>{active.length}</b>限流中</span>)
    } else {
      const detail = rlEntries.map(([k, e]) => `${k} 触发${e.count}次`).join('\n')
      chips.push(<span key="rl" className="sig-chip" title={detail}><b>{rlEntries.length}</b>曾限流</span>)
    }
  }
  if (chips.length === 0) return null
  return <div className="sig-row">{chips}</div>
}

// ── 子 run 网格 ──────────────────────────────────────────────────
function ChildRuns({ run, byId, onSelect }: { run: Run; byId: ById; onSelect: (id: string) => void }) {
  const kids = (run.children ?? []).map(id => byId.get(id)).filter(Boolean) as Run[]
  if (kids.length === 0) return null
  return (
    <>
      <div className="section-title">子 run（{kids.length}）</div>
      <div className="child-grid">
        {kids.map(k => (
          <div key={k.runId} className="child-cell" onClick={() => onSelect(k.runId)}>
            <div className="child-name">{k.feature ?? k.runId}</div>
            <StatusBadge status={k.displayStatus} />
          </div>
        ))}
      </div>
    </>
  )
}

// ── 步骤时间线 ───────────────────────────────────────────────────
function StepTimeline({ run }: { run: Run }) {
  const steps = run.steps ?? []
  const skipped = run.skippedSteps ?? []
  const errSteps = run.errorSteps ?? []
  if (steps.length === 0 && skipped.length === 0 && errSteps.length === 0) return null

  const max = Math.max(...steps.map(s => s.durationMs ?? 0), 1)

  return (
    <>
      <div className="section-title">
        步骤（{steps.length}{skipped.length ? ` · 续跑跳过 ${skipped.length}` : ''}）
      </div>
      <div className="step-list">
        {steps.map(s => <StepItem key={s.key} step={s} max={max} />)}
        {skipped.length > 0 && (
          <div className="faint" style={{ margin: '8px 0 4px', fontSize: 11 }}>↩ 续跑跳过（已完成）：</div>
        )}
        {skipped.map(s => <SkippedItem key={s.key} step={s} />)}
        {errSteps.map(e => <ErrorStepItem key={e.key} step={e} />)}
      </div>
    </>
  )
}

function StepItem({ step, max }: { step: Step; max: number }) {
  const [tab, setTab] = useState<'result' | 'log'>('result')
  const w = Math.max(2, Math.round((step.durationMs ?? 0) / max * 100))
  const hasTokens = step.inputTokens != null || step.outputTokens != null
  const tokLabel = hasTokens ? `${formatTokens((step.inputTokens ?? 0) + (step.outputTokens ?? 0))} tok` : ''
  const waitLabel = step.waitMs != null && step.waitMs > 100 ? `wait ${formatDuration(step.waitMs)}` : ''
  const hasResult = step.result != null && step.result !== ''
  const hasLog = step.rawLog && step.rawLog.length > 0

  return (
    <details className="step-item">
      <summary className="step-summary">
        <span className="step-key mono">
          {step.key}
          {step.model && <span className="step-model">{step.model}</span>}
        </span>
        <span className="tl-bar-wrap"><span className="tl-bar" style={{ width: `${w}%` }} /></span>
        <span className="tl-dur">
          {formatDuration(step.durationMs)}
          {tokLabel && <span className="tl-tok">{tokLabel}</span>}
          {waitLabel && <span className="tl-wait">{waitLabel}</span>}
        </span>
      </summary>
      <div className="step-detail">
        <div className="step-meta">
          {step.cli && <span>CLI <b className="mono">{step.cli}</b></span>}
          {step.model && <span>模型 <b className="mono">{step.model}</b></span>}
          {step.inputTokens != null && <span>输入 <b className="mono">{formatTokens(step.inputTokens)}</b></span>}
          {step.outputTokens != null && <span>输出 <b className="mono">{formatTokens(step.outputTokens)}</b></span>}
          {step.startedAt && <span>开始 <b className="mono">{timeAbs(step.startedAt)}</b></span>}
          {step.completedAt && <span>完成 <b className="mono">{timeAbs(step.completedAt)}</b></span>}
          {step.waitMs != null && step.waitMs > 100 && <span>等待 <b className="mono">{formatDuration(step.waitMs)}</b></span>}
        </div>
        {(hasResult || hasLog) && (
          <>
            <div className="step-tabs">
              {hasResult && (
                <button className={`step-tab ${tab === 'result' ? 'on' : ''}`} onClick={() => setTab('result')}>输出</button>
              )}
              {hasLog && (
                <button className={`step-tab ${tab === 'log' ? 'on' : ''}`} onClick={() => setTab('log')}>日志</button>
              )}
            </div>
            {hasResult && tab === 'result' && (
              <pre className="step-result">{step.result}</pre>
            )}
            {hasLog && tab === 'log' && (
              <pre className="step-result">{JSON.stringify(step.rawLog, null, 2)}</pre>
            )}
          </>
        )}
        {!hasResult && !hasLog && (
          <div className="faint" style={{ padding: '8px 10px', fontSize: 11 }}>（无输出记录）</div>
        )}
      </div>
    </details>
  )
}

function SkippedItem({ step }: { step: SkippedStep }) {
  return (
    <details className="step-item skip">
      <summary className="step-summary">
        <span className="step-key mono">{step.key}</span>
        <span className="tl-bar-wrap"><span className="tl-bar skip" style={{ width: '15%' }} /></span>
        <span className="tl-dur">skip</span>
      </summary>
      <div className="step-detail">
        <div className="faint" style={{ padding: '8px 10px', fontSize: 11 }}>
          续跑时已跳过，结果来自上次存档
        </div>
      </div>
    </details>
  )
}

function ErrorStepItem({ step }: { step: ErrorStep }) {
  const errText = step.error
    ? (typeof step.error === 'string' ? step.error : (step.error as { message?: string })?.message ?? JSON.stringify(step.error, null, 2))
    : 'error'
  return (
    <details className="step-item err">
      <summary className="step-summary">
        <span className="step-key mono">✗ {step.key}</span>
        <span className="step-err-msg">{errText.slice(0, 80)}</span>
        <span className="tl-dur">{step.durationMs != null ? formatDuration(step.durationMs) : '-'}</span>
      </summary>
      <div className="step-detail">
        <pre className="step-result" style={{ color: 'var(--st-failed)' }}>
          {step.error ? (typeof step.error === 'string' ? step.error : JSON.stringify(step.error, null, 2)) : 'error'}
        </pre>
      </div>
    </details>
  )
}

// ── 事件表 ───────────────────────────────────────────────────────
function EventsTable({ events }: { events: RunEvent[] }) {
  if (!events || events.length === 0) return null
  return (
    <>
      <div className="section-title">事件（{events.length}）</div>
      <div className="table-wrap">
        <table className="data-table events-table">
          <thead>
            <tr><th>时间</th><th>事件</th><th>详情</th></tr>
          </thead>
          <tbody>
            {events.map((e, i) => <EventRow key={i} e={e} />)}
          </tbody>
        </table>
      </div>
    </>
  )
}

function EventRow({ e }: { e: RunEvent }) {
  let detail = ''
  if (e.event === 'fallback') {
    detail = `${e.from ?? ''} → ${e.to ?? ''} (${e.reason ?? ''})`
  } else if (e.event === 'gate') {
    detail = `${e.name ?? ''} · ${e.status ?? ''}${e.exitCode != null ? ` exit ${e.exitCode}` : ''}`
  } else if (e.event === 'group') {
    detail = `${e.name ?? ''} · ${e.status ?? ''}${e.reason ? ` (${e.reason})` : ''}`
  } else if (e.event === 'loop') {
    detail = `phase=${e.phase ?? ''}${e.turn != null ? ` turn=${e.turn}` : ''}${e.maxTurns != null ? ` /${e.maxTurns}` : ''}${e.reason ? ` (${e.reason})` : ''}`
  } else {
    detail = JSON.stringify(e).slice(0, 120)
  }
  return (
    <tr>
      <td className="mono faint nowrap">{e.ts ? timeAbs(e.ts) : '-'}</td>
      <td><b>{e.event ?? '-'}</b></td>
      <td className="mono" style={{ fontSize: 12 }}>{detail}</td>
    </tr>
  )
}

// ── 日志尾部 ─────────────────────────────────────────────────────
function LogTails({ run }: { run: Run }) {
  if (!run.logs || run.logs.length === 0) return null
  return (
    <>
      <div className="section-title">日志尾部（{run.logs.length}）</div>
      <div className="log-list">
        {run.logs.map(lg => (
          <details key={lg.name} className="log-item">
            <summary className="mono">{lg.name}</summary>
            <pre className="log-pre">{lg.tail}</pre>
          </details>
        ))}
      </div>
    </>
  )
}
