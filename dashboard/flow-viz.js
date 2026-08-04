// dashboard/flow-viz.js — flow 文件的可视化数据提取原语。
//
// flow 文件是命令式 JS，无法静态解析成 DAG。本模块用 dry-run 执行 flow，
// 读 checkpoint 的 state.json 提取步骤序列，供前端画流程图。
//
// spawn 模式参考 orchestrator/validate.js:217（最小化 env、隔离 HOME、timeout）。
// dry-run 用 fake executor，不调真实 API；gate 自动 pass；loop 只跑 1 轮。
// 故返回的是「一次典型 dry-run 的真实步骤流」，不是完整决策树。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 对一个 flow 文件跑 dry-run，返回提取出的步骤流（用于画图）。
 *
 * @param {string} flowFile  flow 文件绝对路径
 * @param {{ repo?: string, timeout?: number }} [opts]
 * @returns {Promise<object>} FlowGraph 对象
 */
export async function visualizeFlow(flowFile, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS
  const repo = opts.repo ?? process.cwd()

  if (!existsSync(flowFile)) {
    return makeError(flowFile, `flow 文件不存在: ${flowFile}`)
  }

  // 隔离 HOME：dry-run 产物落在 <fakeHome>/.flowcast/dryrun/runs/<runId>/
  // 用临时 HOME 防止读真实 providers.json（与 validate.js 同安全口径）。
  const fakeHome = mkdtempSync(join(tmpdir(), 'flowcast-viz-home-'))
  const dryRunId = `viz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  try {
    // spawn dry-run。最小化 env，带 timeout。
    // --goal 传占位值（dry-run 下 fake executor 不关心 goal 内容）。
    execFileSync('node', [
      flowFile, '--dry-run',
      '--repo', repo,
      '--run-id', dryRunId,
      '--goal', 'viz-demo',
    ], {
      stdio: 'pipe',
      timeout,
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        FLOWCAST_DRY_RUN: '1',
      },
    })
  } catch (e) {
    // dry-run 失败：提取 stderr/stdout 摘要，返回 error 状态（不抛）
    let detail = String(e.stderr ?? e.stdout ?? e.message).trim()
    // 友好化常见错误：flow 不支持 --dry-run 选项
    if (detail.includes('ERR_PARSE_ARGS_UNKNOWN_OPTION') && detail.includes('--dry-run')) {
      detail = `该 flow 文件未声明 --dry-run 选项，不支持可视化。\n` +
        `flowcast 标准 flow 需在 parseArgs 里声明 'dry-run': { type: 'boolean' } 并在检测到时设置 process.env.FLOWCAST_DRY_RUN='1'。\n\n` +
        `原始错误：\n${detail.slice(0, 300)}`
    }
    // 用户级 flow 找不到 flowcast 包（孤立目录，向上找 node_modules 找不到全局 npm 包）
    if (detail.includes('ERR_MODULE_NOT_FOUND') && detail.includes("'flowcast'")) {
      detail = `用户级 flow 找不到 'flowcast' 包。\n\n` +
        `原因：用户级 flow 目录（~/.flowcast/flows/）不在 flowcast 项目内，ESM 解析不到全局 npm 包。\n\n` +
        `修复：在 ~/.flowcast/flows/node_modules/ 下建立 flowcast 软链：\n` +
        `  mkdir -p ~/.flowcast/flows/node_modules\n` +
        `  ln -s $(npm root -g)/flowcast ~/.flowcast/flows/node_modules/flowcast\n\n` +
        `原始错误：\n${detail.slice(0, 200)}`
    }
    // 超时
    if (e.signal === 'SIGTERM' || /timeout/i.test(String(e.message))) {
      detail = `dry-run 执行超时（${timeout}ms）。flow 可能在 dry-run 下卡住（如等待用户输入、或未正确处理 dry-run 分支）。`
    }
    return makeError(flowFile, detail.slice(0, 800) || '(无输出)', dryRunId)
  }

  // 读 dry-run 产出的 state.json
  const statePath = join(fakeHome, '.flowcast', 'dryrun', 'runs', dryRunId, 'state.json')
  if (!existsSync(statePath)) {
    return makeError(flowFile, `dry-run 完成但未找到 state.json（runId=${dryRunId}）`, dryRunId)
  }

  let state
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch (e) {
    return makeError(flowFile, `state.json 解析失败: ${e.message}`, dryRunId)
  }

  // 提取步骤流
  return {
    flowFile,
    flowName: state.flowName ?? basename(flowFile).replace(/\.(m?js)$/, ''),
    runId: dryRunId,
    status: state.status ?? 'unknown',
    error: null,
    steps: extractSteps(state),
    loop: extractLoop(state),
    generatedAt: new Date().toISOString(),
  }
}

/** 从 state.steps[] 提取可视化用的步骤节点。 */
function extractSteps(state) {
  const steps = Array.isArray(state.steps) ? state.steps : []
  return steps.map(s => ({
    key: s.key ?? '(unnamed)',
    status: s.status ?? 'done',
    durationMs: Number.isFinite(s.durationMs) ? s.durationMs : null,
    cli: s.cli ?? null,
    completedAt: s.completedAt ?? null,
  }))
}

/** 若 flow 用了 loop 原语，提取 loop 元信息。 */
function extractLoop(state) {
  if (state.loopTurns == null && !state.loopStatus && !state.loopVerdict) return null
  return {
    turns: state.loopTurns ?? null,
    status: state.loopStatus ?? null,
    verdict: state.loopVerdict ?? null,
  }
}

function makeError(flowFile, error, runId = null) {
  return {
    flowFile,
    flowName: basename(flowFile).replace(/\.(m?js)$/, ''),
    runId,
    status: 'error',
    error,
    steps: [],
    loop: null,
    generatedAt: new Date().toISOString(),
  }
}
