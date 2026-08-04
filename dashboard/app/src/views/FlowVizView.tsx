// FlowVizView — flow 文件的可视化页面（/flows/viz）。
//
// 双 tab：
//   - 静态结构（默认）：AST 解析源码，展示完整步骤结构（含动态模板节点、函数作用域、
//     loop/parallel/fanOut 分组），不执行 flow，零副作用
//   - dry-run 快照：跑一遍拿真实 status/duration，但只展示一条执行路径
import { useEffect, useState } from 'react'
import { api, HttpError } from '../api'
import type { FlowAnalysis, FlowGraph } from '../types'
import { Loading, ErrorBox, formatDuration } from '../components/ui'
import FlowDag from '../components/FlowDag'

type FlowListItem = {
  name: string
  path: string
  scope: 'project' | 'user'
  projectName: string | null
  projectPath?: string
}

type Tab = 'static' | 'dryrun'

export default function FlowVizView() {
  const [flows, setFlows] = useState<FlowListItem[] | null>(null)
  const [selectedFlow, setSelectedFlow] = useState<FlowListItem | null>(null)
  const [analysis, setAnalysis] = useState<FlowAnalysis | null>(null)
  const [graph, setGraph] = useState<FlowGraph | null>(null)
  const [tab, setTab] = useState<Tab>('static')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 打开即加载全部 flow 列表
  useEffect(() => {
    api.listFlows()
      .then(({ flows }) => setFlows(flows))
      .catch(e => { setError(e instanceof HttpError ? e.body.error : String(e)); setFlows([]) })
  }, [])

  // 点击一个 flow → 同时拉静态分析 + dry-run
  const visualize = async (flow: FlowListItem) => {
    setSelectedFlow(flow)
    setLoading(true); setError(null); setAnalysis(null); setGraph(null)
    try {
      const [a, g] = await Promise.all([
        api.analyzeFlow(flow.path),
        api.visualizeFlow(flow.path, flow.projectPath).catch(() => null),  // dry-run 失败不阻断静态
      ])
      setAnalysis(a)
      setGraph(g)
    } catch (e) {
      setError(e instanceof HttpError ? e.body.error : String(e))
    } finally {
      setLoading(false)
    }
  }

  // 按 scope 分组
  const userFlows = (flows ?? []).filter(f => f.scope === 'user')
  const projectFlows = (flows ?? []).filter(f => f.scope === 'project')

  return (
    <div className="col flows-viz-page">
      <div>
        <h2 style={{ margin: '0 0 4px' }}>Flow 可视化</h2>
        <div className="muted" style={{ fontSize: 13 }}>
          点击任意 flow，查看其完整结构（静态分析）或真实执行轨迹（dry-run）。
        </div>
      </div>

      {/* 左右布局：左侧 flow 列表，右侧内容 */}
      <div className="flows-viz-layout">
        {/* 左：flow 列表 */}
        <div className="flows-viz-list">
          {flows === null ? (
            <Loading label="加载 flow 列表…" />
          ) : flows.length === 0 ? (
            <div className="empty" style={{ margin: '20px 0' }}>
              <div className="empty-icon">📜</div>
              <p>没有找到 flow 文件</p>
              <p className="muted">用户级 flow 放 <code>~/.flowcast/flows/</code>，项目级放 <code>.flowcast/flows/</code></p>
            </div>
          ) : (
            <>
              {userFlows.length > 0 && (
                <div className="flow-group">
                  <div className="section-title" style={{ margin: '0 0 6px' }}>用户级（~/.flowcast/flows/）</div>
                  {userFlows.map(f => (
                    <FlowListItemRow key={f.path} flow={f} active={selectedFlow?.path === f.path} onClick={() => visualize(f)} />
                  ))}
                </div>
              )}
              {projectFlows.length > 0 && (
                <div className="flow-group" style={{ marginTop: 16 }}>
                  <div className="section-title" style={{ margin: '0 0 6px' }}>项目级</div>
                  {projectFlows.map(f => (
                    <FlowListItemRow key={f.path} flow={f} active={selectedFlow?.path === f.path} onClick={() => visualize(f)} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* 右：内容 */}
        <div className="flows-viz-detail">
          {loading && <Loading label="分析中…" />}
          {error && !loading && <ErrorBox message={error} />}

          {!loading && analysis && (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                <button className={`btn btn-sm ${tab === 'static' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setTab('static')}>静态结构</button>
                <button className={`btn btn-sm ${tab === 'dryrun' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setTab('dryrun')}>
                  dry-run 快照{graph ? `（${graph.steps.length} 步）` : '（不可用）'}
                </button>
              </div>

              {tab === 'static' && (
                analysis.parseError ? (
                  <div className="card">
                    <h3 className="mono">{analysis.flowName}</h3>
                    <div className="alert alert-err">
                      ⚠️ 解析失败：{analysis.parseError.message}
                      <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                        第 {analysis.parseError.line} 行第 {analysis.parseError.column} 列
                      </div>
                    </div>
                  </div>
                ) : (
                  <FlowDag analysis={analysis} />
                )
              )}
              {tab === 'dryrun' && (
                graph ? <DryrunTimeline graph={graph} />
                  : <div className="muted">该 flow 的 dry-run 不可用（可能未声明 --dry-run 选项）。</div>
              )}
            </>
          )}

          {!loading && !error && !analysis && (
            <div className="empty" style={{ margin: '40px 0' }}>
              <div className="empty-icon">👈</div>
              <p>点击左侧的一个 flow 查看结构图</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── flow 列表行 ──────────────────────────────────────────────────
function FlowListItemRow({ flow, active, onClick }: {
  flow: FlowListItem
  active: boolean
  onClick: () => void
}) {
  return (
    <div className={`flow-list-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="mono flow-list-name">{flow.name}</span>
      {flow.projectName && <span className="faint flow-list-project">{flow.projectName}</span>}
    </div>
  )
}

function DryrunTimeline({ graph }: { graph: FlowGraph }) {
  if (graph.status === 'error') {
    return (
      <div className="card">
        <h3 className="mono">{graph.flowName}</h3>
        <div className="alert alert-err">⚠️ {graph.error}</div>
      </div>
    )
  }
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 16 }}>
        <h3 className="mono" style={{ margin: 0 }}>{graph.flowName}</h3>
        <div className="row" style={{ gap: 12, fontSize: 12 }}>
          <span className="muted">{graph.steps.length} steps</span>
          <span className={`badge badge-${graph.status === 'completed' ? 'completed' : 'unknown'}`}>
            {graph.status}
          </span>
          {graph.loop && <span className="faint">loop: {graph.loop.turns} turns</span>}
        </div>
      </div>
      <div className="alert alert-warn" style={{ marginBottom: 12 }}>
        ⚠ dry-run 只展示一条执行路径（gate 自动通过、loop 只跑 1 轮），pge 这类动态 flow 不完整。
      </div>
      {graph.steps.length === 0 ? (
        <div className="muted">dry-run 没有产生步骤。</div>
      ) : (
        <div className="flow-timeline">
          {graph.steps.map((step, i) => (
            <div key={i} className="flow-node-row">
              <div className="flow-rail">
                <div className={`flow-dot flow-dot-${step.status}`} />
                {i < graph.steps.length - 1 && <div className="flow-line" />}
              </div>
              <div className="flow-node-body">
                <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="mono flow-node-key">{step.key}</span>
                  <span className={`badge badge-${stepStatusToBadge(step.status)}`} style={{ fontSize: 10 }}>
                    {step.status}
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>
                  {step.durationMs != null && <span>{formatDuration(step.durationMs)}</span>}
                  {step.cli && <span className="mono"> · {step.cli}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function stepStatusToBadge(status: string): string {
  if (status === 'done') return 'completed'
  if (status === 'error') return 'failed'
  if (status === 'skip') return 'unknown'
  return 'unknown'
}
