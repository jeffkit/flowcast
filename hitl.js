// hitl.js — HITL（Human-In-The-Loop）子系统
//
// 从 agent.js 抽出，独立成模块。职责单一：管理「等待人类输入/发送通知」的可插拔后端。
//
// 一个 HITL backend 实现 { waitForInput(prompt) → Promise<string>, notify(message) → Promise<void> }。
// flow 启动时用 setHitlBackend 选定：
//   setHitlBackend('terminal')               — 默认，readline
//   setHitlBackend('wecom', { ...config })   — 企微（mcp2cli 或注入 sender）
//   setHitlBackend(customBackendObject)      — 直接注入（测试/宿主集成）

import { realpathSync } from 'fs'
import { join, basename } from 'path'
import { spawnCapture } from './spawn.js'
import { SpawnError, TimeoutError, ConfigError } from './errors.js'

// ── 终端后端 ─────────────────────────────────────────────────────────

const terminalBackend = {
  async waitForInput(prompt) {
    const { createInterface } = await import('readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => {
      // stdin 关闭（CI/管道场景）时 rl 触发 close 但 question 回调不触发，
      // 监听 close 保证不挂死，返回空串让 flow 感知「无输入」并降级处理。
      rl.on('close', () => resolve(''))
      rl.question(`\n${prompt}\n> `, answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
  },
  async notify(message, opts = {}) {
    console.log(`\n[notify] ${message}\n`)
    if (opts.imagePaths?.length) {
      console.log(`[notify] 附件图片：${opts.imagePaths.join(', ')}`)
    }
  },
}

// ── 企微后端 ─────────────────────────────────────────────────────────
//
// 两种接法（优先级从高到低）：
//   1. 注入函数：config.sendAndWait / config.send —— 最易测试
//   2. mcp2cli：shell 调用 wecom-hil MCP 工具

// mcp2cli 路径白名单：只允许默认 mcp2cli（走 PATH 解析）或以下目录下的绝对路径。
// 防止 generated flow / 配置文件注入任意 binary。
const MCP2CLI_ALLOWED_DIRS = [
  '/usr/local/bin',
  '/usr/bin',
  '/opt/homebrew/bin',
  '/opt/local/bin',
  join(process.env.HOME ?? '', '.local', 'bin'),
]

function resolveMcp2cliPath(input) {
  if (input === 'mcp2cli') return input
  if (typeof input !== 'string' || !input.startsWith('/')) {
    throw new ConfigError(`wecom backend: mcp2cli 必须是 'mcp2cli'（默认）或绝对路径，收到: ${input}`)
  }
  let resolved
  try { resolved = realpathSync(input) } catch {
    throw new ConfigError(`wecom backend: mcp2cli 路径不存在或无法解析: ${input}`)
  }
  if (basename(resolved) !== 'mcp2cli') {
    throw new ConfigError(`wecom backend: mcp2cli 路径不在白名单目录（basename 必须是 mcp2cli）: ${input}（resolved: ${resolved}）`)
  }
  const allowed = MCP2CLI_ALLOWED_DIRS.some(d => d && (resolved.startsWith(d + '/') || resolved === d))
  if (!allowed) {
    throw new ConfigError(`wecom backend: mcp2cli 路径不在白名单目录（${MCP2CLI_ALLOWED_DIRS.filter(Boolean).join(', ')}）: ${input}（resolved: ${resolved}）`)
  }
  return resolved
}

function resolveMcpServerName(input) {
  if (typeof input !== 'string' || !/^@[\w.-]+(\/[\w.-]+)?$/.test(input)) {
    throw new ConfigError(`wecom backend: server 必须是 @<name> 或 @<namespace>/<name> 形式，收到: ${input}`)
  }
  return input
}

function makeWecomBackend(config = {}) {
  const projectName = config.projectName ?? 'flowcast'
  const chatId = config.chatId ?? null
  const ctx = { projectName, chatId }

  if (typeof config.sendAndWait === 'function' || typeof config.send === 'function') {
    return {
      async waitForInput(prompt) {
        if (typeof config.sendAndWait !== 'function') {
          throw new ConfigError('wecom backend: sendAndWait 未配置，无法等待回复')
        }
        return await config.sendAndWait(prompt, ctx)
      },
      async notify(message, opts = {}) {
        if (typeof config.send === 'function') return void await config.send(message, { ...ctx, imagePaths: opts.imagePaths })
      },
    }
  }

  // mcp2cli 真实实现
  const mcp2cli = resolveMcp2cliPath(config.mcp2cli ?? 'mcp2cli')
  const server = resolveMcpServerName(config.server ?? '@hitl')
  const waitTimeoutMs = config.waitTimeoutMs ?? 86_400_000  // 默认 24h
  const callTool = async (tool, message, { wait, imagePaths }) => {
    const toolCli = tool.replace(/_/g, '-')
    const payload = JSON.stringify({
      message,
      project_name: projectName,
      ...(chatId ? { chat_id: chatId } : {}),
      ...(imagePaths?.length ? { image_paths: imagePaths } : {}),
    })
    const timeout = wait ? waitTimeoutMs : 60_000
    const { stdout, exitCode, timedOut, spawnError } = await spawnCapture(
      mcp2cli, [server, toolCli, '--stdin'], { timeout, stdin: payload }
    )
    if (spawnError) throw new SpawnError('[wecom] mcp2cli 未找到或无法启动', null, { cause: String(spawnError) })
    if (timedOut) throw new TimeoutError(`[wecom] HITL 等待超时（${timeout}ms 内无回复）`)
    if (exitCode !== 0) throw new SpawnError('[wecom] mcp2cli 异常退出', null, { exitCode, output: stdout.slice(0, 200) })
    return stdout
  }
  return {
    async waitForInput(prompt) {
      const out = await callTool('send_and_wait_reply', prompt, { wait: true })
      try {
        const data = JSON.parse(out)
        return data?.replies?.[0]?.content ?? out.trim()
      } catch { return out.trim() }
    },
    async notify(message, opts = {}) {
      await callTool('send_message_only', message, { wait: false, imagePaths: opts.imagePaths }).catch(err => {
        console.warn(`[wecom notify] 失败（忽略）：${err.message}`)
      })
    },
  }
}

// ── 全局后端状态 ─────────────────────────────────────────────────────
//
// 默认 null：未调 setHitlBackend 时 waitForInput/notify 必须 fast-fail，
// 防止在非 TTY（CI/cron/subflow 子进程）下用 terminal 后端静默挂死。

let _hitlBackend = null

/** 选定 HITL 后端：'terminal' | 'wecom' | 自定义 backend 对象。 */
export function setHitlBackend(backend, config = {}) {
  if (backend && typeof backend === 'object') { _hitlBackend = backend; return }
  if (backend === 'terminal') { _hitlBackend = terminalBackend; return }
  if (backend === 'wecom') { _hitlBackend = makeWecomBackend(config); return }
  throw new ConfigError(`未知 HITL 后端: ${backend}（支持 terminal/wecom/自定义对象）`)
}

/** 当前 HITL 后端（测试 / 调试用）。 */
export function getHitlBackend() { return _hitlBackend }

/** 阻塞等待人类输入。未配置后端则 fast-fail，避免非 TTY 静默挂死。 */
export async function waitForInput(prompt) {
  if (!_hitlBackend) {
    throw new ConfigError('HITL 后端未配置：请在 flow 启动时调用 setHitlBackend("terminal"|"wecom"|customBackend)（非 TTY 环境下必须显式选后端）')
  }
  return _hitlBackend.waitForInput(prompt)
}

/**
 * 单向通知人类，不等待。
 * @param {string} message 文本消息
 * @param {{ imagePaths?: string[] }} [opts] 可选项（WeCom 后端支持附带本地图片）
 */
export async function notify(message, opts = {}) {
  if (!_hitlBackend) {
    throw new ConfigError('HITL 后端未配置：请在 flow 启动时调用 setHitlBackend(...) 后再 notify')
  }
  return _hitlBackend.notify(message, opts)
}
