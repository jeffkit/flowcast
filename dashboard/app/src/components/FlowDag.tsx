// FlowDag — flow 静态结构的 DAG 图渲染（React Flow + dagre 布局）。
//
// 输入：FlowAnalysis（AST 解析结果：steps[] + groups[]）
// 输出：可缩放拖拽的 DAG 图
//   - 每个 step = 自定义节点（动态节点虚线 + 🧩 徽标）
//   - 相邻 step 连边（源码顺序的隐式依赖）
//   - loop/parallel/fanOut = 容器节点（parentId 子图）
import { useMemo, useState } from 'react'
import {
  ReactFlow, Handle, Position, MarkerType,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import type { FlowAnalysis, FlowAnalysisStep, FlowAnalysisBranch } from '../types'

const NODE_W = 200
const NODE_H = 44
const GROUP_PAD = 28  // 容器内边距（给标签留空间）
const ACTION_W = 110  // 容器内 action 子节点尺寸
const ACTION_H = 24

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
    <div className={cls}>
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

type GroupNodeData = { label: string; childCount: number; collapsed: boolean }
type GroupNodeType = Node<GroupNodeData, 'groupbox'>

// 自定义 group 容器（带类型标签 + 折叠按钮）
function GroupNode({ data }: NodeProps<GroupNodeType>) {
  const label = data.label
  const icon = label === 'loop' ? '↻'
    : label === 'parallel' ? '∥'
    : label === 'fanOut' ? '⇶'
    : label === 'for' ? '↻'
    : '↺'
  return (
    <div className={`flow-group-box flow-group-${label} ${data.collapsed ? 'collapsed' : ''}`}>
      <div className="flow-group-label">
        <span className="flow-group-toggle" data-collapse-toggle="true">
          {data.collapsed ? '▸' : '▾'}
        </span>
        {icon} {label}
        {data.childCount > 0 && <span className="flow-group-count">{data.childCount}</span>}
      </div>
    </div>
  )
}

const nodeTypes = { step: StepNode, groupbox: GroupNode, action: ActionNode }

// ── 主组件 ───────────────────────────────────────────────────────
export default function FlowDag({ analysis }: { analysis: FlowAnalysis }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const { nodes, edges } = useMemo(
    () => buildDag(analysis, collapsed),
    [analysis, collapsed],
  )

  // 容器标题栏点击 → 折叠/展开
  const toggleGroup = (gid: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      return next
    })
  }

  return (
    <div className="flow-dag-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.type === 'groupbox') toggleGroup(node.id)
        }}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.1}
        maxZoom={2}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ zIndex: 1 }}
      />
    </div>
  )
}

// ── DAG 构建 + dagre 布局 ────────────────────────────────────────

function buildDag(analysis: FlowAnalysis, collapsed: Set<string> = new Set()): { nodes: Node[]; edges: Edge[] } {
  const steps = analysis.steps
  if (steps.length === 0) return { nodes: [], edges: [] }

  // step → 所属最内层 group id
  const stepGroupId = new Map<number, string>()
  const groupChildren = new Map<string, number[]>()
  // group 的 actions（容器内子节点）
  const groupActions = new Map<string, Array<{ name: string; line: number }>>()

  for (const [gi, g] of analysis.groups.entries()) {
    const gid = `grp-${g.type}-${gi}`
    for (const idx of g.childStepIndexes) {
      stepGroupId.set(idx, gid)
      const list = groupChildren.get(gid) ?? []
      list.push(idx)
      groupChildren.set(gid, list)
    }
    if (g.actions?.length) groupActions.set(gid, g.actions)
  }

  // ── 节点 ──
  const nodes: Node[] = []
  const stepIds: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const id = `step-${i}`
    stepIds.push(id)
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
  // group 容器节点 + action 子节点（放最前，parent 必须在 child 前）
  const groupNodes: Node[] = []
  for (const [gid, children] of groupChildren) {
    const type = gid.split('-')[1]
    const isCollapsed = collapsed.has(gid)
    groupNodes.push({
      id: gid,
      type: 'groupbox',
      position: { x: 0, y: 0 },
      style: { width: 0, height: 0 },
      data: { label: type, childCount: children.length, collapsed: isCollapsed },
    })
    // action 子节点（展示"这个组在做什么"）
    const actions = groupActions.get(gid) ?? []
    for (let ai = 0; ai < actions.length; ai++) {
      const aid = `act-${gid}-${ai}`
      groupNodes.push({
        id: aid,
        type: 'action',
        position: { x: 0, y: 0 },
        parentId: gid,
        data: { name: actions[ai].name, line: actions[ai].line },
        width: ACTION_W,
        height: ACTION_H,
      })
    }
  }
  nodes.unshift(...groupNodes)

  // ── if/else 分支：哪些相邻边要断开，分叉/汇聚边 ──
  // branch 覆盖的 step 范围：thenSteps ∪ elseSteps 的最小/最大 index
  const branchRanges = analysis.branches.map(b => {
    const all = [...b.thenSteps, ...b.elseSteps]
    return all.length ? { min: Math.min(...all), max: Math.max(...all) } : null
  }).filter(Boolean) as Array<{ min: number; max: number }>

  // 判断 step i 是否属于某个分支内部
  const inBranchRange = (i: number) => branchRanges.some(r => i >= r.min && i <= r.max)

  // 边集合：默认相邻 i→i+1，但"跨分支边界"的边断开（由分叉/汇聚边替代）
  // 分支内部相邻 step 保留边（then 内 0→1→2 正常连线），只断：
  //   - 分支外 step → 分支内 step（改为分叉边）
  //   - 分支内 step → 分支外 step（改为汇聚边）
  const edgeSet = new Set<string>()
  const addEdge = (from: number, to: number) => {
    if (from === to) return
    edgeSet.add(`${from}->${to}`)
  }

  for (let i = 0; i < steps.length - 1; i++) {
    const crossBoundary = inBranchRange(i) !== inBranchRange(i + 1)
    // then→else / else→then 跨分支边（同 branch 内 but 不同 side）也断
    const crossSide = steps[i].inIf && steps[i + 1].inIf &&
      steps[i].inIfBranch !== steps[i + 1].inIfBranch
    if (!crossBoundary && !crossSide) addEdge(i, i + 1)
  }

  // 分叉：if 前节点 → then 第一个 / else 第一个
  for (const b of analysis.branches) {
    const then = b.thenSteps
    const els = b.elseSteps
    if (then.length === 0 && els.length === 0) continue
    // 找 if 前最近的 step（不在任何 branch 内的）
    const before = findPrevStep(b, analysis.branches)
    if (before !== null) {
      if (then.length) addEdge(before, then[0])
      if (els.length) addEdge(before, els[0])
    }
    // 汇聚：then 最后一个 + else 最后一个 → 分支后下一个 step
    const after = findNextStep(steps, b, analysis.branches)
    const thenLast = then.length ? then[then.length - 1] : null
    const elsLast = els.length ? els[els.length - 1] : null
    if (after !== null) {
      if (thenLast !== null) addEdge(thenLast, after)
      if (elsLast !== null) addEdge(elsLast, after)
    }
  }

  // ── 边 ──
  const edges: Edge[] = []
  for (const e of edgeSet) {
    const [from, to] = e.split('->').map(Number)
    const branchInfo = branchEdgeInfo(from, to, analysis.branches)
    edges.push({
      id: `e-${from}-${to}`,
      source: stepIds[from],
      target: stepIds[to],
      type: 'smoothstep',
      style: branchInfo?.style,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    })
  }

  // loop group 回边：最后一个子 → 第一个子（虚线，表示循环语义）
  for (const [gid, children] of groupChildren) {
    if (!gid.startsWith('grp-loop-')) continue
    const sorted = [...children].sort((a, b) => a - b)
    if (sorted.length < 2) continue
    const first = stepIds[sorted[0]]
    const last = stepIds[sorted[sorted.length - 1]]
    if (last === first) continue
    edges.push({
      id: `loop-back-${gid}`,
      source: last,
      target: first,
      type: 'smoothstep',
      style: { stroke: 'var(--st-running)', strokeDasharray: '6 4', opacity: 0.7 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--st-running)' },
    })
  }

  // ── dagre 布局（step 节点 + action 节点；group 容器手动计算）──
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 40 })
  for (let i = 0; i < steps.length; i++) {
    g.setNode(stepIds[i], { width: NODE_W, height: NODE_H })
  }
  // action 节点：挂在 group 内，不参与 dagre 主干布局（避免干扰），
  // 但 dagre 需要它们存在才不会报错——用独立小图布局或直接跳过。
  // 这里：action 节点不加入 dagre（它们的坐标由容器计算时基于行号排布）。
  for (const e of edgeSet) {
    const [from, to] = e.split('->').map(Number)
    g.setEdge(stepIds[from], stepIds[to])
  }
  dagre.layout(g)

  // 回填 step 节点位置
  for (let i = 0; i < steps.length; i++) {
    const p = g.node(stepIds[i])
    const node = nodes.find(n => n.id === stepIds[i])!
    node.position = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 }
    const gid = stepGroupId.get(i)
    if (gid) {
      ;(node.data as StepNodeData & { _absX?: number; _absY?: number })._absX = node.position.x
      ;(node.data as StepNodeData & { _absX?: number; _absY?: number })._absY = node.position.y
    }
  }

  // ── group 容器：根据子节点 bounding box 计算位置/尺寸（含 action）──
  for (const [gid, children] of groupChildren) {
    const gnode = nodes.find(n => n.id === gid)!
    const isCollapsed = collapsed.has(gid)
    const actions = groupActions.get(gid) ?? []

    if (isCollapsed) {
      // 折叠：子节点隐藏，容器缩小为标题栏高度
      for (const idx of children) {
        const s = nodes.find(n => n.id === `step-${idx}`)!
        s.hidden = true
      }
      for (let ai = 0; ai < actions.length; ai++) {
        const an = nodes.find(n => n.id === `act-${gid}-${ai}`)!
        an.hidden = true
      }
      gnode.style = { width: 160, height: 30 }
      continue
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const idx of children) {
      const s = nodes.find(n => n.id === `step-${idx}`)!
      const abs = (s.data as StepNodeData & { _absX?: number; _absY?: number })
      const x = abs._absX ?? s.position.x
      const y = abs._absY ?? s.position.y
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + NODE_W)
      maxY = Math.max(maxY, y + NODE_H)
    }
    const boxX = minX - GROUP_PAD
    const boxY = minY - GROUP_PAD - 16
    const boxW = maxX - minX + GROUP_PAD * 2
    const boxH = maxY - minY + GROUP_PAD * 2 + 16
    gnode.position = { x: boxX, y: boxY }
    gnode.style = { width: boxW, height: boxH }
    // step 子节点转相对坐标
    for (const idx of children) {
      const s = nodes.find(n => n.id === `step-${idx}`)!
      const abs = (s.data as StepNodeData & { _absX?: number; _absY?: number })
      s.position = {
        x: (abs._absX ?? s.position.x) - boxX,
        y: (abs._absY ?? s.position.y) - boxY,
      }
      s.parentId = gid
      delete (s.data as StepNodeData & { _absX?: number })._absX
      delete (s.data as StepNodeData & { _absY?: number })._absY
    }
    // action 子节点：排在容器底部（step 下方），按行号排列
    for (let ai = 0; ai < actions.length; ai++) {
      const aid = `act-${gid}-${ai}`
      const an = nodes.find(n => n.id === aid)!
      // 容器底部中央排布
      const totalW = actions.length * (ACTION_W + 8) - 8
      const startX = (boxW - totalW) / 2
      an.position = { x: startX + ai * (ACTION_W + 8), y: boxH - ACTION_H - 12 }
      an.parentId = gid
    }
  }

  return { nodes, edges }
}

/** 找 if 分支前最近的 step（不在任何 branch 范围内，index < branch.min）。 */
function findPrevStep(branch: FlowAnalysisBranch, branches: FlowAnalysisBranch[]): number | null {
  const all = [...branch.thenSteps, ...branch.elseSteps]
  if (all.length === 0) return null
  const min = Math.min(...all)
  // 向前找第一个不属于任何 branch 的 step
  for (let i = min - 1; i >= 0; i--) {
    const inBranch = branches.some(b => {
      const ba = [...b.thenSteps, ...b.elseSteps]
      return ba.includes(i)
    })
    if (!inBranch) return i
  }
  return null
}

/** 找 if 分支后最近的 step（不在任何 branch 范围内，index > branch.max）。 */
function findNextStep(steps: FlowAnalysisStep[], branch: FlowAnalysisBranch, branches: FlowAnalysisBranch[]): number | null {
  const all = [...branch.thenSteps, ...branch.elseSteps]
  if (all.length === 0) return null
  const max = Math.max(...all)
  for (let i = max + 1; i < steps.length; i++) {
    const inBranch = branches.some(b => {
      const ba = [...b.thenSteps, ...b.elseSteps]
      return ba.includes(i)
    })
    if (!inBranch) return i
  }
  return null
}

/** 判断一条边是否是分叉/汇聚边（then/else 相关），返回样式提示。 */
function branchEdgeInfo(from: number, to: number, branches: FlowAnalysisBranch[]): { style?: object } | null {
  for (const b of branches) {
    const then = b.thenSteps
    const els = b.elseSteps
    // 进入 then 分支（from 是 if 前，to 是 then 第一个）
    if (then.includes(to) && !then.includes(from)) {
      return { style: { stroke: 'var(--st-completed)', strokeDasharray: '4 3' } }
    }
    // 进入 else 分支
    if (els.includes(to) && !els.includes(from)) {
      return { style: { stroke: 'var(--st-running)', strokeDasharray: '4 3' } }
    }
  }
  return null
}
