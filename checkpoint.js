import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'

export class Checkpoint {
  constructor(runId, stateDir = '.flowx/runs') {
    this.runId = runId
    this.dir = join(stateDir, runId)
    this.path = join(this.dir, 'state.json')
    this.logPath = join(this.dir, 'run.log.jsonl')  // 每行一条结构化日志
    mkdirSync(this.dir, { recursive: true })
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : { runId, status: 'running', completed: {}, steps: [], startedAt: new Date().toISOString() }
    this._flush()
  }

  // 核心：有缓存就跳过，没有就执行并存档
  async step(key, fn, { meta = {} } = {}) {
    if (this.state.completed[key] !== undefined) {
      console.log(`  [skip] ${key}`)
      return this.state.completed[key]
    }
    console.log(`  [run]  ${key}`)
    this.state.currentStep = key
    this._flush()

    const startedAt = Date.now()
    let result, error

    try {
      result = await fn()
    } catch (e) {
      error = e.message
      this._log({ key, status: 'error', error, durationMs: Date.now() - startedAt, meta })
      throw e
    }

    const durationMs = Date.now() - startedAt
    this.state.completed[key] = result
    this.state.currentStep = null

    // 记录到 steps 列表（摘要用）和 jsonl 日志（完整审计用）
    const stepRecord = { key, status: 'done', durationMs, completedAt: new Date().toISOString(), ...meta }
    this.state.steps.push(stepRecord)
    this._log({ key, status: 'done', durationMs, result, meta })
    this._flush()
    return result
  }

  // HITL：暂停并干净退出，下次从这里继续
  pause(reason, context = {}) {
    console.log(`\n[paused] ${reason}`)
    this.state.status = 'paused'
    this.state.pauseReason = reason
    this.state.pauseContext = context
    this._log({ key: '__pause__', status: 'paused', reason })
    this._flush()
    process.exit(0)
  }

  // 标记整个 workflow 完成，生成可读报告
  done(summary = {}) {
    this.state.status = 'completed'
    this.state.completedAt = new Date().toISOString()
    this.state.summary = summary
    this._flush()
    this._writeReport()
  }

  // 是否已记录过某个 key（fan-out 时用来跳过已完成的子任务）
  has(key) { return this.state.completed[key] !== undefined }

  // 并发安全地记录一个已算好的结果（非 fn）。整段同步执行、无 await，
  // 单线程下并发回调也不会交错，适合 parallel/fanOut 里各子任务回写完成状态。
  record(key, result, meta = {}) {
    this.state.completed[key] = result
    this.state.steps.push({ key, status: 'done', completedAt: new Date().toISOString(), ...meta })
    this._flush()
    return result
  }

  getPauseContext() { return this.state.pauseContext || {} }
  get status() { return this.state.status }

  // ── 内部工具 ────────────────────────────────────────────────────

  _log(entry) {
    appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  }

  _flush() {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2))
  }

  // 生成人可读的 Markdown 报告
  _writeReport() {
    const s = this.state
    const totalMs = new Date(s.completedAt) - new Date(s.startedAt)
    const totalSec = (totalMs / 1000).toFixed(1)

    const stepRows = s.steps.map(st => {
      const sec = (st.durationMs / 1000).toFixed(1)
      const cli = st.cli ?? '-'
      return `| ${st.key} | ${st.status} | ${sec}s | ${cli} |`
    }).join('\n')

    const report = `# Workflow Run Report

**Run ID**: ${s.runId}
**Status**: ${s.status}
**Started**: ${s.startedAt}
**Completed**: ${s.completedAt}
**Total time**: ${totalSec}s

## Summary
${Object.entries(s.summary).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

## Steps

| Step | Status | Duration | CLI |
|------|--------|----------|-----|
${stepRows}

## Full log
See \`run.log.jsonl\` for complete inputs/outputs per step.
`
    writeFileSync(join(this.dir, 'report.md'), report)
    console.log(`\n📋 报告已生成：${join(this.dir, 'report.md')}`)
  }
}
