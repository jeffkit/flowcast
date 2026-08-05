// types.ts — 前后端 API 契约。
//
// 这里的类型严格对应 dashboard/collect.js + dashboard/index.js 产出的 model 对象。
// collect.js 是权威数据源；本文件是其 TypeScript 投影。
// 后端返回的 JSON 直接可被这些类型标注。

// ── 登记薄（projects.js）──────────────────────────────────────────
export interface ProjectEntry {
  id: string
  name: string
  path: string
  addedAt: string          // ISO
  lastOpenedAt: string     // ISO
}

export interface ProjectsResponse {
  projects: Array<ProjectEntry & {
    summary?: { stats: Stats; generatedAt: string } | null
    summaryError?: string
  }>
}

export interface AddProjectBody {
  path: string
  name?: string
}

// ── 单项目 model（collectRuns + buildModel）───────────────────────

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'unknown'
// displayStatus 额外含 stale（running 但超阈值）
export type DisplayStatus = RunStatus | 'stale'

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  hasTokens: boolean
}

export interface RawLogEntry {
  key?: string
  status?: string
  ts?: string
  durationMs?: number
  error?: unknown
  cli?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  [k: string]: unknown
}

export interface RunEvent {
  event?: string
  ts?: string
  result?: string
  [k: string]: unknown
}

export interface LogFile {
  name: string
  tail: string
  mtimeMs: number
}

export interface ErrorStep {
  key: string
  error: unknown
  durationMs: number | null
}

export interface SkippedStep {
  key: string
  status: 'skip'
}

export interface Step {
  key: string
  status: string
  durationMs: number | null
  startedAt: string | null
  completedAt: string | null
  cli: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  result: string | null
  rawLog: RawLogEntry[]
  waitMs: number | null
}

export interface Signals {
  fallback: number
  fallbackByScope: Record<string, number>
  gatePass: number
  gateFail: number
  group: { done: number; failed: number }
  fixRounds: number
  loop: { turns: number; done: number; budgetExhausted: number; failed: number }
  rateLimits: Record<string, { availableAt: number; source: string; count: number }>
}

export interface Run {
  runId: string
  dir: string
  state: Record<string, unknown>
  status: RunStatus
  stale: boolean
  orphanedStateFile: boolean
  displayStatus: DisplayStatus
  feature: string | null
  flowPath: string | null
  flowName: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  currentStep: string | null
  pauseReason: string | null
  summary: Record<string, unknown> | null
  completedCount: number
  stepCount: number
  skippedCount: number
  errorSteps: ErrorStep[]
  skippedSteps: SkippedStep[]
  paused: boolean
  usage: Usage
  models: string[]
  steps: Step[]
  events: RunEvent[]
  signals: Signals
  lastActivityMs: number
  lastActivity: string | null
  logs: LogFile[]
  parentId: string | null
  parentIdSource: 'explicit' | 'heuristic' | null
  children: string[]
  childUsage: Usage | null
}

export interface WorkflowGroup {
  flowName: string
  total: number
  running: number
  completed: number
  paused: number
  stale: number
  other: number
  totalTokens: number
  lastActivityMs: number | null
}

export interface Stats {
  total: number
  running: number
  paused: number
  completed: number
  stale: number
  other: number
  fallback: number
  gateFail: number
  gatePass: number
  skipped: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  rateLimits: Record<string, { availableAt: number; source: string; count: number }>
}

export interface Agent {
  name: string
  executor: string | null
  model: string | null
  provider: string | null
  configured: boolean
  installed: boolean
  authed: boolean | null
  authDetail: string | null
  ready: boolean
  path: string | null
}

export interface FlowEntry {
  name: string
  path: string
  scope: 'project' | 'user'
}

export interface Workflows {
  project: FlowEntry[]
  user: FlowEntry[]
  all: FlowEntry[]
}

// buildModel 返回的完整对象（即 GET /api/projects/:id/model 的响应体）
export interface ProjectModel {
  repo: string
  generatedAt: string
  staleMs: number
  runs: Run[]
  roots: string[]
  stats: Stats
  byWorkflow: Record<string, WorkflowGroup>
  agents: Agent[]
  workflows: Workflows
  _collectWarning?: string
}

// ── API 错误响应 ──────────────────────────────────────────────────
export interface ApiError {
  error: string
  code?: string
  message?: string
  existingId?: string
  id?: string
}

// ── Agent / Provider 配置（config-store）──────────────────────────

export type ConfigScope = 'user' | 'project'

/** 已知 executor（来自 /api/config/executors）*/
export interface KnownExecutor {
  name: string
  byoLlm: boolean
}

/** agent profile 原始字段（对应 agents.json 里的一个 profile）*/
export interface AgentProfile {
  executor: string
  provider?: string
  model?: string
  timeout?: number
  maxSteps?: number
  allowTools?: string
  extraArgs?: string[]
  transcriptOut?: string
  pricingFile?: string
  files?: string[]
  cwd?: string
  _comment?: string
}

/** provider 原始字段 + 后端补充的 env 状态 */
export interface ProviderConfig {
  type?: string
  apiBase?: string
  model?: string
  apiKey?: string
  _envVar?: string | null   // 从 apiKey 解析出的环境变量名
  _envSet?: boolean | null  // 该环境变量是否已设
}

/** scanAgents 结果（装机/凭证状态）*/
export interface ScannedAgent {
  cli: string
  executor: string | null
  acceptsProvider: boolean
  installed: boolean
  path: string | null
  authed: boolean | null
  authDetail: string | null
  ready: boolean
}

// ── Flow 可视化（flow-viz）────────────────────────────────────────

export interface FlowVizStep {
  key: string
  status: string
  durationMs: number | null
  cli: string | null
  completedAt: string | null
}

export interface FlowLoop {
  turns: number | null
  status: string | null
  verdict: string | null
}

export interface FlowGraph {
  flowFile: string
  flowName: string
  runId: string | null
  status: 'completed' | 'failed' | 'error' | 'unknown' | string
  error: string | null
  steps: FlowVizStep[]
  loop: FlowLoop | null
  generatedAt: string
}

// ── Flow 静态分析（AST）─────────────────────────────────────────

export interface FlowAnalysisStep {
  key: string
  dynamic: boolean
  template: string | null
  line: number
  scope: string
  inLoop: boolean
  inLoopKind: 'for' | 'while' | 'loop()' | null
  inParallelDepth: number
  inFanOut: boolean
  inIf: boolean
  inIfBranch: 'then' | 'else' | null
}

export interface FlowAnalysisGroup {
  type: 'loop' | 'parallel' | 'fanOut' | 'for' | 'while'
  line: number
  lineEnd: number
  scope: string
  childStepIndexes: number[]
  actions: Array<{ name: string; line: number }>
}

export interface FlowAnalysisBranch {
  type: 'if'
  line: number
  lineEnd: number
  thenSteps: number[]
  elseSteps: number[]
}

export interface FlowAnalysisCall {
  caller: string
  callee: string
  line: number
}

export interface FlowAnalysis {
  flowFile: string
  flowName: string
  steps: FlowAnalysisStep[]
  groups: FlowAnalysisGroup[]
  branches: FlowAnalysisBranch[]
  calls: FlowAnalysisCall[]
  parseError: null | { message: string; line: number; column: number }
  generatedAt: string
}

