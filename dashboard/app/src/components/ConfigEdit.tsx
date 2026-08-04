// ConfigEdit — agent / provider 编辑表单弹窗。
//
// 安全约束：provider 的 apiKey 字段只接受环境变量名（如 DEEPSEEK_API_KEY），
// 后端会包成 ${...}；不接受明文密钥。
import { useState } from 'react'
import { api, HttpError } from '../api'
import type { KnownExecutor, AgentProfile, ProviderConfig, ConfigScope } from '../types'

function DialogShell({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void
}) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog card config-dialog" onClick={e => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Agent 编辑表单 ───────────────────────────────────────────────
export function AgentEditDialog({ name, initial, executors, providers, scope, repo, onClose, onSaved }: {
  name?: string
  initial?: AgentProfile
  executors: KnownExecutor[]
  providers: Record<string, ProviderConfig>
  scope: ConfigScope
  repo?: string
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!name
  const [formName, setFormName] = useState(name ?? '')
  const [executor, setExecutor] = useState(initial?.executor ?? 'claude')
  const [model, setModel] = useState(initial?.model ?? '')
  const [provider, setProvider] = useState(initial?.provider ?? '')
  const [timeout, setTimeout] = useState(initial?.timeout ? String(initial.timeout) : '')
  const [maxSteps, setMaxSteps] = useState(initial?.maxSteps ? String(initial.maxSteps) : '')
  const [extraArgs, setExtraArgs] = useState((initial?.extraArgs ?? []).join(' '))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const executorInfo = executors.find(e => e.name === executor)
  const providerNames = Object.keys(providers)

  const submit = async () => {
    setErr(null)
    if (!formName.trim()) { setErr('请填名称'); return }
    const profile: AgentProfile = { executor }
    if (model.trim()) profile.model = model.trim()
    if (provider.trim()) profile.provider = provider.trim()
    if (timeout.trim()) {
      const n = Number(timeout)
      if (!Number.isFinite(n) || n <= 0) { setErr('timeout 必须是正数'); return }
      profile.timeout = n
    }
    if (maxSteps.trim()) {
      const n = Number(maxSteps)
      if (!Number.isFinite(n) || n <= 0) { setErr('maxSteps 必须是正数'); return }
      profile.maxSteps = n
    }
    const args = extraArgs.trim().split(/\s+/).filter(Boolean)
    if (args.length) profile.extraArgs = args

    setBusy(true)
    try {
      await api.saveConfigAgent(formName.trim(), profile, scope, repo)
      onSaved()
    } catch (e) {
      setErr(e instanceof HttpError ? e.body.error : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell title={isEdit ? `编辑 ${name}` : '新增 agent'} onClose={onClose}>
      <div className="col config-form">
        <label className="muted">名称（profile 名）</label>
        <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
          disabled={isEdit} placeholder="如 claude-sonnet / rec-ds" autoFocus={!isEdit} />

        <label className="muted">executor（CLI 类型）</label>
        <select value={executor} onChange={e => { setExecutor(e.target.value); setProvider('') }}>
          {executors.map(e => (
            <option key={e.name} value={e.name}>
              {e.name}{e.byoLlm ? ' (BYO-LLM)' : ''}
            </option>
          ))}
        </select>

        {executorInfo?.byoLlm ? (
          <>
            <label className="muted">provider（可选，绑定 LLM 端点）</label>
            <select value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="">（不绑定，用 CLI 自带凭证）</option>
              {providerNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        ) : provider ? (
          <div className="faint" style={{ fontSize: 12 }}>
            ⚠ {executor} 不支持自定义 provider，已清除
          </div>
        ) : null}

        <label className="muted">model（可选）</label>
        <input type="text" value={model} onChange={e => setModel(e.target.value)} placeholder="如 claude-sonnet-4-5" />

        <div className="row" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label className="muted">timeout（毫秒，可选）</label>
            <input type="text" value={timeout} onChange={e => setTimeout(e.target.value)} placeholder="如 1800000" />
          </div>
          <div style={{ flex: 1 }}>
            <label className="muted">maxSteps（可选）</label>
            <input type="text" value={maxSteps} onChange={e => setMaxSteps(e.target.value)} placeholder="如 40" />
          </div>
        </div>

        <label className="muted">extraArgs（空格分隔，按白名单过滤）</label>
        <input type="text" value={extraArgs} onChange={e => setExtraArgs(e.target.value)}
          placeholder="如 --dangerously-skip-permissions" className="mono" />

        {err && <div style={{ color: 'var(--st-failed)', fontSize: 13 }}>⚠️ {err}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <><span className="spinner" /> 保存中…</> : '保存'}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}

// ── Provider 编辑表单 ────────────────────────────────────────────
export function ProviderEditDialog({ name, initial, scope, repo, onClose, onSaved }: {
  name?: string
  initial?: ProviderConfig
  scope: ConfigScope
  repo?: string
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!name
  // apiKey 字段：编辑时显示环境变量名（去掉 ${}），新建时空
  const initialEnvVar = initial?._envVar ?? (initial?.apiKey ? stripEnv(initial.apiKey) : '')
  const [formName, setFormName] = useState(name ?? '')
  const [type, setType] = useState(initial?.type ?? 'openai')
  const [apiBase, setApiBase] = useState(initial?.apiBase ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [envVar, setEnvVar] = useState(initialEnvVar)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setErr(null)
    if (!formName.trim()) { setErr('请填名称'); return }
    const provider: ProviderConfig = {}
    if (type) provider.type = type
    if (apiBase.trim()) provider.apiBase = apiBase.trim()
    if (model.trim()) provider.model = model.trim()
    if (envVar.trim()) provider.apiKey = `\${${envVar.trim()}}`  // 包成 ${VAR}

    setBusy(true)
    try {
      await api.saveConfigProvider(formName.trim(), provider, scope, repo)
      onSaved()
    } catch (e) {
      setErr(e instanceof HttpError ? e.body.error : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell title={isEdit ? `编辑 ${name}` : '新增 provider'} onClose={onClose}>
      <div className="col config-form">
        <label className="muted">名称</label>
        <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
          disabled={isEdit} placeholder="如 deepseek / glm" autoFocus={!isEdit} />

        <label className="muted">协议族</label>
        <select value={type} onChange={e => setType(e.target.value)}>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>

        <label className="muted">apiBase</label>
        <input type="text" value={apiBase} onChange={e => setApiBase(e.target.value)}
          placeholder="https://api.deepseek.com/v1" className="mono" />

        <label className="muted">model（默认模型）</label>
        <input type="text" value={model} onChange={e => setModel(e.target.value)}
          placeholder="如 deepseek-v4-flash" className="mono" />

        <label className="muted">API Key 环境变量名</label>
        <input type="text" value={envVar} onChange={e => setEnvVar(e.target.value)}
          placeholder="如 DEEPSEEK_API_KEY（不要直接填密钥）" className="mono" />
        <div className="faint" style={{ fontSize: 11, marginTop: -4 }}>
          填环境变量名，系统自动包成 <code>{'${...}'}</code>。绝不接受明文密钥。
        </div>

        {err && <div style={{ color: 'var(--st-failed)', fontSize: 13 }}>⚠️ {err}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <><span className="spinner" /> 保存中…</> : '保存'}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}

/** 从 ${VAR} 提取裸名 VAR；若不是该格式则原样返回。 */
function stripEnv(s: string): string {
  const m = s.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/)
  return m ? m[1] : s
}
