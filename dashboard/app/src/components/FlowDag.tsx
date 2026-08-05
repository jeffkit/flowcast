// FlowDag — flow 静态结构的 DAG 图渲染（React Flow + elkjs 复合图布局）。
//
// 输入：FlowAnalysis（AST 解析结果：steps[] + groups[] + branches[]）
// 输出：可缩放拖拽的 DAG 图
//   - 每个 step = 自定义节点（动态节点虚线 + 🧩 徽标）
//   - loop/parallel/fanOut/for/while = 容器节点（elkjs 复合图，自动布局避免重叠）
//   - 子流程（helper 函数调用，callee 含 step 的 scope）= 内联展开的容器，
//     默认展开 1 层（main 的直接子流程铺开），更深层默认折叠成 📦 盒子。
//   - if/else 分叉边（绿/橙虚线）
//   - elkjs 边路由（ORTHOGONAL）让边自动绕开容器
//
// 关键设计（v2）：不再按 selectedScope 过滤「一次画一个 scope」。而是从 main 出发
// BFS 调用链（analysis.calls），把所有可达 scope 的 step 放进同一张图，子流程作为
// 容器内联展开。这样默认就能看到完整主干（main → runAttempt → ...）。
import { useMemo, useState, useLayoutEffect } from 'react'
import {
  ReactFlow, Handle, Position, MarkerType, MiniMap, Controls, Background, Panel,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react'
import type { FlowAnalysis } from '../types'

// elkjs 很大（~1.4MB），动态 import 按需加载（只在 Flow 可视化页用到）。
// 用 module-level promise + useLayoutEffect 里 await，避免阻塞其他页面。
const elkPromise = import('elkjs/lib/elk.bundled.js').then(m => new m.default())

const NODE_W = 200
const NODE_H = 44
const ACTION_W = 110
const ACTION_H = 24

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '48',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
}

type ActionNodeData = { name: string; line: number }
type ActionNodeType = Node<ActionNodeData, 'action'>

// 容器内 action 子节点（展示"这个组在做什么"）
function ActionNode({ data }: NodeProps<ActionNodeType>) {
  return (
    <div className="action-node mono" title={`L${data.line}`}>
      <span className="action-node-icon">⚙</span>
      <span className="action-node-name">{data.name}</span>
    </div>
  )
}

type StepNodeData = {
  key: string
  dynamic: boolean
  template: string | null
  line: number
  scope: string
  inIf: boolean
  inIfBranch: 'then' | 'else' | null
  inLoop: boolean
  inLoopKind: 'for' | 'while' | 'loop()' | null
  inParallelDepth: number
  inFanOut: boolean
}
type StepNodeType = Node<StepNodeData, 'step'>

// ── 自定义 step 节点 ─────────────────────────────────────────────
function StepNode({ data }: NodeProps<StepNodeType>) {
  const cls = [
    'step-node',
    data.dynamic ? 'step-node--dynamic' : '',
    data.inIf ? `step-node--if step-node--if-${data.inIfBranch ?? 'then'}` : '',
  ].filter(Boolean).join(' ')
  return (
    <div className={cls} title={data.template ? `模板：${data.template}` : `L${data.line} · ${data.scope}`}>
      <Handle type="target" position={Position.Top} />
      <div className="step-node-key mono">
        {data.key}
        {data.dynamic && (
          <span className="step-node-dyn" title={`动态 key：${data.template ?? '运行时确定'}`}>🧩</span>
        )}
      </div>
      <div className="step-node-meta">
        <span>L{data.line} · {data.scope}</span>
        {data.inIf && (
          <span className={`step-node-tag step-node-tag-${data.inIfBranch ?? 'then'}`}
            title="该步骤在 if/else 分支内，是否执行取决于运行时条件">
            {data.inIfBranch === 'else' ? 'else' : 'if'}
          </span>
        )}
        {data.inLoop && (
          <span className="step-node-tag" title="该步骤在循环内">
            {data.inLoopKind === 'loop()' ? 'loop()' : 'for/while'}
          </span>
        )}
        {data.inParallelDepth > 0 && (
          <span className="step-node-tag" title="该步骤在 parallel 内">∥</span>
        )}
        {data.inFanOut && (
          <span className="step-node-tag" title="该步骤在 fanOut 内">⇶</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

type GroupNodeData = { label: string; childCount: number; collapsed: boolean; scopeName?: string }
type GroupNodeType = Node<GroupNodeData, 'groupbox'>

// 自定义 group 容器（带类型标签 + 折叠按钮）。子流程容器也复用它（label='subflow'）。
function GroupNode({ data }: NodeProps<GroupNodeType>) {
  const label = data.label
  const icon = label === 'loop' ? '↻'
    : label === 'parallel' ? '∥'
    : label === 'fanOut' ? '⇶'
    : label === 'subflow' ? '📦'
    : '↻'
  return (
    <div className={`flow-group-box flow-group-${label} ${data.collapsed ? 'collapsed' : ''}`}>
      <div className="flow-group-label">
        <span className="flow-group-toggle">{data.collapsed ? '▸' : '▾'}</span>
        {icon} {label === 'subflow' && data.scopeName ? data.scopeName : label}
        {data.childCount > 0 && <span className="flow-group-count">{data.childCount}</span>}
      </div>
    </div>
  )
}

// ── 子流程入口节点（折叠态：callee 含 step 但未展开时，作为主线上的可展开盒子）──
type SubflowEntryNodeData = { name: string; stepCount: number }
type SubflowEntryNodeType = Node<SubflowEntryNodeData, 'subflow-entry'>

function SubflowEntryNode({ data }: NodeProps<SubflowEntryNodeType>) {
  return (
    <div className="subflow-entry-node" title={`点击展开 ${data.name}() 的子流程（${data.stepCount} 步）`}>
      <Handle type="target" position={Position.Top} />
      <div className="subflow-entry-row">
        <span className="subflow-entry-icon">📦</span>
        <span className="subflow-entry-name mono">{data.name}()</span>
        <span className="subflow-entry-count">{data.stepCount}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const nodeTypes = {
  step: StepNode,
  groupbox: GroupNode,
  action: ActionNode,
  'subflow-entry': SubflowEntryNode,
}

// ── 调用树 BFS ────────────────────────────────────────────────────
// 从 main 出发，用 analysis.calls 收集所有可达 scope（callee 必须含 step 才算子流程）。
// 防 analysis.calls 里的环（互递归）和重复（同 caller→callee 多次调用）。
type ScopeTreeNode = { scope: string; parent: string | null; depth: number; callLine: number }

function buildScopeTree(analysis: FlowAnalysis): Map<string, ScopeTreeNode> {
  const scopesWithSteps = new Set(analysis.steps.map(s => s.scope))
  // caller → callees（去重，保留首次 line）
  const calleeMap = new Map<string, Map<string, number>>()
  for (const c of analysis.calls) {
    if (!scopesWithSteps.has(c.callee)) continue   // callee 无 step → 不算子流程
    if (c.callee === c.caller) continue            // 自调用跳过
    let m = calleeMap.get(c.caller)
    if (!m) { m = new Map(); calleeMap.set(c.caller, m) }
    if (!m.has(c.callee)) m.set(c.callee, c.line)
  }

  const tree = new Map<string, ScopeTreeNode>()
  tree.set('main', { scope: 'main', parent: null, depth: 0, callLine: 0 })
  const queue = ['main']
  const visited = new Set<string>(['main'])
  while (queue.length) {
    const cur = queue.shift()!
    const node = tree.get(cur)!
    const callees = calleeMap.get(cur)
    if (!callees) continue
    for (const [callee, line] of callees) {
      if (visited.has(callee)) continue   // 防环 + 防重复展开
      visited.add(callee)
      tree.set(callee, { scope: callee, parent: cur, depth: node.depth + 1, callLine: line })
      queue.push(callee)
    }
  }
  return tree
}

// ── 主组件 ───────────────────────────────────────────────────────
export default function FlowDag({ analysis }: { analysis: FlowAnalysis }) {
  const [layouted, setLayouted] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null)

  // 调用树（决定哪些 scope 进图、谁是谁的子流程容器）
  const scopeTree = useMemo(() => buildScopeTree(analysis), [analysis])

  // 折叠状态 = 默认（深度>1 的子流程折叠）+ 用户 override（显式 toggle 过的容器）
  // 注意：finalCollapsed 必须在 buildBaseGraph 之前算，因为折叠的 subflow 直接不把
  // 子 step 放进图（确定性，不依赖 fromElk 的 hidden 机制）。
  const [userOverride, setUserOverride] = useState<Record<string, boolean>>({})
  const finalCollapsed = useMemo(() => {
    const s = new Set<string>()
    // 默认：深度 > 1 的子流程（孙级及更深）折叠，depth=1 的直接子流程展开
    for (const [, node] of scopeTree) {
      if (node.depth > 1) s.add(`subflow-${node.scope}`)
    }
    for (const [id, expanded] of Object.entries(userOverride)) {
      if (expanded) s.delete(id)
      else s.add(id)
    }
    return s
  }, [scopeTree, userOverride])

  // 基础数据：所有可达 scope 的 step 同图 + 子流程容器归属。
  // 折叠的 subflow 内部 step 不进图（只保留容器节点本身作为折叠盒子）。
  const base = useMemo(() => buildBaseGraph(analysis, scopeTree, finalCollapsed), [analysis, scopeTree, finalCollapsed])

  // elkjs 异步布局
  useLayoutEffect(() => {
    let alive = true
    setLayouted(null)
    elkPromise.then(elk => {
      return elk.layout(toElkJson(base, finalCollapsed) as any, { layoutOptions: ELK_OPTIONS })
    }).then(g => {
      if (!alive) return
      setLayouted(fromElk(g, base, finalCollapsed))
    }).catch(err => {
      console.error('elkjs layout failed:', err)
      if (alive) setLayouted({ nodes: base.nodes, edges: base.edges })
    })
    return () => { alive = false }
  }, [base, finalCollapsed])

  const toggleGroup = (gid: string) => {
    setUserOverride(prev => {
      const next = { ...prev }
      // 当前是否折叠？（合并默认 + override 后的状态）
      const isCollapsed = finalCollapsed.has(gid)
      next[gid] = isCollapsed   // true=展开（原来是折叠的）
      return next
    })
  }

  const { nodes, edges } = layouted ?? { nodes: base.nodes, edges: base.edges }

  const expandAll = () => {
    const o: Record<string, boolean> = {}
    for (const n of base.subflowNodes) o[n.id] = true
    setUserOverride(o)
  }
  const collapseAll = () => {
    const o: Record<string, boolean> = {}
    for (const n of base.subflowNodes) o[n.id] = false
    setUserOverride(o)
  }

  return (
    <div className="flow-dag-container">
      <div className="flow-dag-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => {
            if (node.type === 'groupbox') toggleGroup(node.id)
            else if (node.type === 'subflow-entry') toggleGroup(node.id)
          }}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable={false}
          nodesConnectable={false}
          minZoom={0.05}
          maxZoom={2}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{ zIndex: 1 }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              if (n.type === 'groupbox') return 'var(--border-light)'
              if (n.type === 'subflow-entry') return 'var(--accent)'
              return 'var(--text-faint)'
            }}
            maskColor="rgba(15,17,21,0.7)"
          />
          <Panel position="top-left">
            <div className="flow-dag-toolbar">
              <button className="btn btn-sm btn-ghost" onClick={expandAll}>展开全部</button>
              <button className="btn btn-sm btn-ghost" onClick={collapseAll}>收起全部</button>
              <span className="flow-dag-legend">
                <span className="legend-item"><span className="legend-dot legend-dot-subflow" />子流程</span>
                <span className="legend-item"><span className="legend-dot legend-dot-loop" />循环</span>
                <span className="legend-item"><span className="legend-dot legend-dot-dyn" />动态</span>
              </span>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  )
}

// ── 基础图构建（节点 + 边定义，不含坐标）────────────────────────

type SubflowNodeInfo = { id: string; scope: string; depth: number; collapsed: boolean }

type BaseGraph = {
  nodes: Node[]
  edges: Edge[]
  // step 的全局 id（stepKey 形式：`${scope}:${origIdx}`）→ 所属 group 容器 id
  stepGroupId: Map<string, string>
  // step 全局 id → 所属 subflow 容器 id（只在子流程展开时才有）
  stepSubflowId: Map<string, string>
  // group 容器 id → 子 step 的全局 key 列表
  groupChildren: Map<string, string[]>
  // subflow 容器 id → 子 step 的全局 key 列表（展开态）
  subflowChildren: Map<string, string[]>
  groupActions: Map<string, Array<{ name: string; line: number }>>
  // 所有 subflow 容器节点信息（含折叠态用的入口节点）
  subflowNodes: SubflowNodeInfo[]
  // step 全局 key → 在 nodes 数组里的 id（边构造用）
  stepKeyToNodeId: Map<string, string>
}

function buildBaseGraph(analysis: FlowAnalysis, scopeTree: Map<string, ScopeTreeNode>, collapsed: Set<string>): BaseGraph {
  // 收集要进图的 step：scopeTree 里的所有 scope（main + 可达子流程），
  // 但折叠的 subflow 内部 step 不进图（容器节点本身保留，显示成折叠盒子）。
  const reachableScopes = new Set(scopeTree.keys())
  const collapsedScopes = new Set<string>()
  for (const id of collapsed) {
    if (id.startsWith('subflow-')) collapsedScopes.add(id.replace('subflow-', ''))
  }

  // 给每个 step 分配全局 key `${scope}:${origIdx}`
  // 反向：scope → 该 scope 的 step 全局 key 列表（按 origIdx 序）
  const scopeSteps = new Map<string, string[]>()
  for (let i = 0; i < analysis.steps.length; i++) {
    const s = analysis.steps[i]
    if (!reachableScopes.has(s.scope)) continue
    // 折叠的 subflow 内部 step 不进图
    if (collapsedScopes.has(s.scope)) continue
    const key = `${s.scope}:${i}`
    let arr = scopeSteps.get(s.scope)
    if (!arr) { arr = []; scopeSteps.set(s.scope, arr) }
    arr.push(key)
  }

  // 子流程容器：所有 scopeTree 里的非 main scope 都建容器。
  // 折叠态由 buildBaseGraph 收到的 collapsed 决定（子 step 已在上面被排除），
  // 容器节点本身保留，fromElk 不再需要隐藏子节点。
  const subflowNodes: SubflowNodeInfo[] = []
  const subflowChildren = new Map<string, string[]>()
  const stepSubflowId = new Map<string, string>()
  for (const [scope, node] of scopeTree) {
    if (scope === 'main') continue
    const id = `subflow-${scope}`
    const isCollapsed = collapsedScopes.has(scope)
    subflowNodes.push({ id, scope, depth: node.depth, collapsed: isCollapsed })
    const children = scopeSteps.get(scope) ?? []
    subflowChildren.set(id, children)
    for (const k of children) stepSubflowId.set(k, id)
  }

  // groups（loop/parallel/fanOut/for/while）：用行范围匹配，作用域限定在该 group 所属 scope
  const stepGroupId = new Map<string, string>()
  const groupChildren = new Map<string, string[]>()
  const groupActions = new Map<string, Array<{ name: string; line: number }>>()
  for (const [gi, g] of analysis.groups.entries()) {
    if (!reachableScopes.has(g.scope)) continue
    const scopeArr = scopeSteps.get(g.scope) ?? []
    const localChildren: string[] = []
    for (const key of scopeArr) {
      const origIdx = Number(key.split(':')[1])
      const s = analysis.steps[origIdx]
      if (s.line >= g.line && s.line <= g.lineEnd) {
        localChildren.push(key)
        stepGroupId.set(key, `grp-${g.type}-${gi}`)
      }
    }
    if (localChildren.length > 0 || g.type === 'loop' || g.type === 'parallel' || g.type === 'fanOut') {
      const gid = `grp-${g.type}-${gi}`
      groupChildren.set(gid, localChildren)
      if (g.actions?.length) groupActions.set(gid, g.actions)
    }
  }

  const stepKeyToNodeId = new Map<string, string>()

  // ── 构造节点 ──
  const nodes: Node[] = []

  // 1. subflow 容器节点（先建，子 step 归属用）。折叠态用固定尺寸。
  for (const info of subflowNodes) {
    nodes.push({
      id: info.id,
      type: 'groupbox',
      position: { x: 0, y: 0 },
      style: info.collapsed ? { width: 180, height: 40 } : { width: 0, height: 0 },
      data: {
        label: 'subflow',
        scopeName: info.scope,
        childCount: subflowChildren.get(info.id)?.length ?? 0,
        collapsed: info.collapsed,
      },
    })
  }

  // 2. group 容器节点
  for (const [gid, children] of groupChildren) {
    const type = gid.split('-')[1]
    nodes.push({
      id: gid,
      type: 'groupbox',
      position: { x: 0, y: 0 },
      style: { width: 0, height: 0 },
      data: { label: type, childCount: children.length, collapsed: false },
    })
    const actions = groupActions.get(gid) ?? []
    for (let ai = 0; ai < actions.length; ai++) {
      const aid = `act-${gid}-${ai}`
      nodes.push({
        id: aid,
        type: 'action',
        position: { x: 0, y: 0 },
        data: { name: actions[ai].name, line: actions[ai].line },
        width: ACTION_W,
        height: ACTION_H,
      })
    }
  }

  // 3. step leaf 节点
  for (const [scope, keys] of scopeSteps) {
    for (const key of keys) {
      const origIdx = Number(key.split(':')[1])
      const s = analysis.steps[origIdx]
      const id = `step-${scope}-${origIdx}`
      stepKeyToNodeId.set(key, id)
      nodes.push({
        id,
        type: 'step',
        position: { x: 0, y: 0 },
        data: {
          key: s.key,
          dynamic: s.dynamic,
          template: s.template,
          line: s.line,
          scope: s.scope,
          inIf: s.inIf,
          inIfBranch: s.inIfBranch,
          inLoop: s.inLoop,
          inLoopKind: s.inLoopKind,
          inParallelDepth: s.inParallelDepth,
          inFanOut: s.inFanOut,
        },
        width: NODE_W,
        height: NODE_H,
      })
    }
  }

  // ── 构造边 ──
  // 策略：每个 scope 内部按 step 原始顺序连相邻边（跨 if 分支断开）。
  //       跨 scope 的边：caller scope 的最后一个 step → 子流程容器；子流程容器内
  //       的 step 由 elkjs 容器内布局。但容器自身不参与边——所以跨 scope 边连到
  //       子流程 scope 内 line 最小的 step（"入口 step"）。子流程出口（line 最大 step）
  //       不自动连回 caller 下一个 step（避免假依赖），caller 后续 step 自然排在后面。
  const edges: Edge[] = []
  const edgeSet = new Set<string>()

  // scope 内部相邻边
  for (const [, keys] of scopeSteps) {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = analysis.steps[Number(keys[i].split(':')[1])]
      const b = analysis.steps[Number(keys[i + 1].split(':')[1])]
      // 跨 if 分支断开
      const crossSide = a.inIf && b.inIf && a.inIfBranch !== b.inIfBranch
      if (crossSide) continue
      const fromId = stepKeyToNodeId.get(keys[i])!
      const toId = stepKeyToNodeId.get(keys[i + 1])!
      const ek = `${fromId}->${toId}`
      if (edgeSet.has(ek)) continue
      edgeSet.add(ek)
      let style: object | undefined
      if (b.inIf) {
        style = b.inIfBranch === 'else'
          ? { stroke: 'var(--st-running)', strokeDasharray: '4 3' }
          : { stroke: 'var(--st-completed)', strokeDasharray: '4 3' }
      }
      edges.push({
        id: `e-${fromId}-${toId}`,
        source: fromId,
        target: toId,
        type: 'smoothstep',
        style,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      })
    }
  }

  // 跨 scope 边：caller scope → 子流程（展开时连入口 step，折叠时连容器本身）
  for (const info of subflowNodes) {
    const tnode = scopeTree.get(info.scope)!
    const parent = tnode.parent!
    const parentKeys = scopeSteps.get(parent) ?? []
    const childKeys = subflowChildren.get(info.id) ?? []
    // 折叠态：子 step 不在图里，边直接连到容器节点
    const targetId = info.collapsed
      ? info.id
      : (() => {
          if (childKeys.length === 0) return null
          const entryKey = childKeys.reduce((min, k) =>
            analysis.steps[Number(k.split(':')[1])].line < analysis.steps[Number(min.split(':')[1])].line ? k : min, childKeys[0])
          return stepKeyToNodeId.get(entryKey) ?? null
        })()
    if (!targetId) continue

    // 找 caller: caller scope 里 line 不超过调用点、且最接近调用点的 step
    // （子流程调用发生在某个 step 的 lambda 或 main 序列里）
    const callLine = tnode.callLine
    let callerStepKey: string | null = null
    let callerStepLine = -1
    for (const k of parentKeys) {
      const sl = analysis.steps[Number(k.split(':')[1])].line
      if (sl <= callLine && sl > callerStepLine) { callerStepLine = sl; callerStepKey = k }
    }
    // caller 可能也折叠了（parentKeys 为空）→ 连到父容器
    let fromId: string | null = null
    if (callerStepKey) fromId = stepKeyToNodeId.get(callerStepKey) ?? null
    if (!fromId) {
      // parent 是折叠的 subflow，连到父容器节点
      const parentId = `subflow-${parent}`
      if (nodes.some(n => n.id === parentId)) fromId = parentId
    }
    if (fromId) {
      const ek = `${fromId}->${targetId}`
      if (!edgeSet.has(ek)) {
        edgeSet.add(ek)
        edges.push({
          id: `e-${fromId}-${targetId}`,
          source: fromId,
          target: targetId,
          type: 'smoothstep',
          style: { stroke: 'var(--accent)', strokeDasharray: '5 3' },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--accent)' },
        })
      }
    }
  }

  // loop group 回边（沿用原逻辑，改用全局 key）
  for (const [gid, children] of groupChildren) {
    if (!gid.startsWith('grp-loop')) continue
    if (children.length < 2) continue
    const sorted = [...children].sort((a, b) =>
      analysis.steps[Number(a.split(':')[1])].line - analysis.steps[Number(b.split(':')[1])].line)
    const first = stepKeyToNodeId.get(sorted[0])!
    const last = stepKeyToNodeId.get(sorted[sorted.length - 1])!
    if (last === first) continue
    const ek = `${last}->${first}`
    if (edgeSet.has(ek)) continue
    edgeSet.add(ek)
    edges.push({
      id: `loop-back-${gid}`,
      source: last,
      target: first,
      type: 'smoothstep',
      style: { stroke: 'var(--st-running)', strokeDasharray: '6 4', opacity: 0.7 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--st-running)' },
    })
  }

  return {
    nodes, edges, stepGroupId, stepSubflowId,
    groupChildren, subflowChildren, groupActions,
    subflowNodes, stepKeyToNodeId,
  }
}

// ── ELK 复合图 JSON ──────────────────────────────────────────────

function toElkJson(base: BaseGraph, collapsed: Set<string>) {
  const { nodes, edges, groupChildren, subflowChildren, stepSubflowId, stepGroupId } = base

  // step 全局 key → ELK leaf（用于容器 children 引用）
  const stepElkByKey = new Map<string, { id: string; width: number; height: number }>()
  const elkNodesById = new Map<string, object>()
  const elkNodes: object[] = []

  // 先建 leaf 节点（step + action）
  for (const n of nodes) {
    if (n.type === 'step') {
      const id = n.id
      const e = { id, width: NODE_W, height: NODE_H }
      elkNodesById.set(id, e)
      // 反查 key：id 形如 `step-${scope}-${origIdx}`，但 scope 可能含 -，需从 base.stepKeyToNodeId 反查
      // 直接用 id 作为唯一引用即可（key→id 映射在 base.stepKeyToNodeId）
    } else if (n.type === 'action') {
      const e = { id: n.id, width: ACTION_W, height: ACTION_H }
      elkNodesById.set(n.id, e)
      elkNodes.push(e)
    }
  }
  // 建 key→ELK leaf 映射（供容器 children 用）
  for (const [key, id] of base.stepKeyToNodeId) {
    stepElkByKey.set(key, elkNodesById.get(id) as any)
  }

  // 再建容器节点（group + subflow），children 嵌套
  // 注意：一个 step leaf 只能有一个 parent。归属优先级：group 在内、subflow 在外。
  // 先把 group 容器建好（children 是直接归属该 group 的 step），
  // 再把 subflow 容器建好（children 是该 scope 里【不归属任何 group】的 step + 归属该 scope 的 group 容器）。

  // group 容器
  const groupElkById = new Map<string, object>()
  for (const [gid, children] of groupChildren) {
    const isCollapsed = collapsed.has(gid)
    const childElks = isCollapsed ? [] : (children.map(k => stepElkByKey.get(k)).filter(Boolean) as object[])
    const actions = base.groupActions.get(gid) ?? []
    if (!isCollapsed) {
      for (let ai = 0; ai < actions.length; ai++) {
        const aid = `act-${gid}-${ai}`
        const e = elkNodesById.get(aid)
        if (e) childElks.push(e)
      }
    }
    const type = gid.split('-')[1]
    const container: any = {
      id: gid,
      layoutOptions: {
        'elk.padding': '[top=30,left=16,bottom=16,right=16]',
        'elk.algorithm': type === 'parallel' ? 'layered' : undefined,
      },
      children: childElks,
    }
    if (isCollapsed) { container.width = 160; container.height = 32 }
    groupElkById.set(gid, container)
    elkNodesById.set(gid, container)
    // group 内部的 step leaf 不进顶层（已进 group.children）
    // group 自身是否进顶层，取决于它是否归属 subflow（见下）
  }

  // subflow 容器。折叠态在 buildBaseGraph 已处理（子 step 不在图里、容器 data.collapsed=true），
  // 这里只按 info.collapsed 决定 children（折叠时为空）。
  const subflowElkById = new Map<string, object>()
  for (const info of base.subflowNodes) {
    const isCollapsed = info.collapsed
    const childKeys = subflowChildren.get(info.id) ?? []
    const childElks: object[] = []
    if (!isCollapsed) {
      // 收集该 subflow 的 children：不归属 group 的 step leaf + 该 scope 的 group 容器
      for (const key of childKeys) {
        const gid = stepGroupId.get(key)
        if (gid) {
          // 这个 step 归 group，不直接进 subflow（它已在 group 容器里）
          continue
        }
        const e = stepElkByKey.get(key)
        if (e) childElks.push(e)
      }
      // 该 scope 的 group 容器作为 subflow 的 child
      for (const [gid, _children] of groupChildren) {
        const firstChild = _children[0]
        if (!firstChild) continue
        const childScope = firstChild.split(':')[0]
        if (childScope === info.scope) {
          const ge = groupElkById.get(gid)
          if (ge) childElks.push(ge)
        }
      }
    }
    const container: any = {
      id: info.id,
      layoutOptions: {
        'elk.padding': '[top=30,left=16,bottom=16,right=16]',
        'elk.algorithm': 'layered',
      },
      children: childElks,
    }
    if (isCollapsed) { container.width = 180; container.height = 40 }
    subflowElkById.set(info.id, container)
    elkNodesById.set(info.id, container)
    elkNodes.push(container)
  }

  // 顶层 children：main scope 的 step（不归属 subflow、不归属 group）+ 顶层 subflow 容器 + 顶层 group
  // 关键：已归属 subflow/group 的 leaf 不进顶层
  for (const n of nodes) {
    if (n.type !== 'step') continue
    // 反查这个 step 的 key
    let key: string | null = null
    for (const [k, id] of base.stepKeyToNodeId) {
      if (id === n.id) { key = k; break }
    }
    if (!key) continue
    const inSubflow = stepSubflowId.has(key)
    const inGroup = stepGroupId.has(key)
    if (!inSubflow && !inGroup) {
      const e = elkNodesById.get(n.id)
      if (e) elkNodes.push(e)
    }
  }
  // 顶层 group（scope=main 且不在 subflow 内的 group）
  for (const [gid, children] of groupChildren) {
    const firstChild = children[0]
    if (!firstChild) {
      // 空 group（只有 actions 的 loop/parallel/fanOut）
      const ge = groupElkById.get(gid)
      if (ge) elkNodes.push(ge)
      continue
    }
    const childScope = firstChild.split(':')[0]
    if (childScope === 'main') {
      const ge = groupElkById.get(gid)
      if (ge) elkNodes.push(ge)
    }
  }

  // 边（声明在 root）
  const elkEdges = edges.map(e => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }))

  return {
    id: 'root',
    layoutOptions: {},
    children: elkNodes,
    edges: elkEdges,
  }
}

// ── ELK 结果 → React Flow 节点/边 ────────────────────────────────

function fromElk(g: any, base: BaseGraph, collapsed: Set<string>): { nodes: Node[]; edges: Edge[] } {
  // 递归收集所有节点（含容器内子节点），记录parentId 用于 React Flow parentId 嵌套
  const laid = new Map<string, { x: number; y: number; parentId?: string }>()
  const collect = (children: any[], parentId?: string) => {
    for (const c of children) {
      laid.set(c.id, { x: c.x, y: c.y, parentId })
      if (c.children?.length) collect(c.children, c.id)
    }
  }
  collect(g.children ?? [])

  // 节点的折叠态由 base.nodes 里自带的 data.collapsed 决定（subflow 在 buildBaseGraph 设好；
  // group 在下面根据 collapsed 参数同步）。
  const nodes = base.nodes.map(n => {
    const l = laid.get(n.id)
    const isGroup = n.type === 'groupbox' && n.data?.label !== 'subflow'
    const isCollapsed = isGroup ? collapsed.has(n.id) : !!n.data?.collapsed
    const collapsedSize = n.data?.label === 'subflow'
      ? { width: 180, height: 40 }
      : { width: 160, height: 32 }
    return {
      ...n,
      position: l ? { x: l.x, y: l.y } : { x: 0, y: 0 },
      style: isCollapsed ? collapsedSize : n.style,
      data: {
        ...n.data,
        collapsed: isCollapsed,
      },
      hidden: false,
      parentId: l?.parentId,
    }
  })

  // 隐藏折叠 group 的子节点（subflow 折叠已在 buildBaseGraph 排除子 step，无需这里处理）
  const hiddenIds = new Set<string>()
  for (const [gid, children] of base.groupChildren) {
    if (!collapsed.has(gid)) continue
    for (const key of children) {
      const id = base.stepKeyToNodeId.get(key)
      if (id) hiddenIds.add(id)
    }
    const actions = base.groupActions.get(gid) ?? []
    for (let ai = 0; ai < actions.length; ai++) hiddenIds.add(`act-${gid}-${ai}`)
  }

  const finalNodes = nodes.map(n => ({
    ...n,
    hidden: hiddenIds.has(n.id) ? true : (n.hidden ?? false),
  }))

  const edges = base.edges.map(e => ({
    ...e,
    hidden: hiddenIds.has(e.source) || hiddenIds.has(e.target) ? true : (e.hidden ?? false),
  }))

  return { nodes: finalNodes, edges }
}
