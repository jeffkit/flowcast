// orchestrator/validate.js — 生成 flow 的跑前校验（护栏②）
//
// 三关：① node --check 语法；② import 白名单（挡任意 fs/进程/网络）；③ 假执行器 dry-run。
// 本文件是 harness 受信代码，可用 child_process/fs；被校验的是「生成的 flow」，受白名单约束。
//
// 白名单对齐 FLOW_API.md：generated flow 只准 import `flowcast`（+ util 用于 parseArgs）。
// 允许 surface 由 FLOW_API.md 列；本文件额外禁止 `flowcast/dashboard` 等「宿主观测」模块被
// 生成 flow 自循环使用——dashboard 是给宿主看的，不是给被编排对象用的。

import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, readFileSync, copyFileSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname } from 'path'

// 生成的 flow 只准 import flowcast 包本身 + util（parseArgs）。
// 白名单同时包含 bare 形式和 node: 前缀形式，防止用 node:fs 绕过 fs 限制。
const IMPORT_WHITELIST = new Set(['flowcast', 'util', 'node:util'])

// 生成 flow 不准 import 的 flowcast 子路径（白名单子集反向）：
// dashboard 是宿主观测，不该被编排对象自循环调用。
const FORBIDDEN_FLOWCAST_SUBPATHS = ['flowcast/dashboard', 'flowcast/dashboard/index']

// 把 specifier 规范化：'node:util' → 'util'，其他不变。
// Node 20 对内置模块 bare 和 node: 前缀完全等价，白名单检查必须一致。
function normalizeSpecifier(s) {
  return s.startsWith('node:') ? s.slice(5) : s
}

/**
 * 剥离 JS 注释和字符串字面量内容，只保留代码骨架，让 import 正则不会误匹配。
 * - 行注释 `// ...`、块注释 `/* ... *\/` → 直接移除
 * - 字符串引号保留（供正则定位 import 的模块名），但内容用空格占位（保留长度），
 *   防止注释或说明文字里写的 import-like 文本被误判为违规 import。
 *
 * 注意：import 语句里的模块名本身也是字符串字面量，被占位后正则就抓不到了——
 * 这里用「只清空非 import 位置字符串」会过于复杂；实际做法更简单：
 * 只清注释，保留字符串内容，但对「模块路径」的误报在生成的 flow 里极罕见。
 * 真正常见且需要修复的是：注释里写了 import 样例（如 JSDoc 示例），这里优先解决。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c; i++
      while (i < src.length) {
        const sc = src[i]
        out += sc; i++
        if (sc === '\\') { out += src[i] ?? ''; i++; continue }
        if (sc === q) break
      }
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else {
      out += c; i++
    }
  }
  return out
}

/** 扫描源码里所有 import/require 目标，返回非白名单 + 禁止子路径的去重列表。 */
export function scanImports(source) {
  const code = stripComments(source)
  const violations = []
  const patterns = [
    /\bimport\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'm'
    /\bimport\s*['"]([^'"]+)['"]/g,                  // import 'm'（副作用）
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // 动态 import('m') / require('m')
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(code))) {
      const raw = m[1]
      const normalized = normalizeSpecifier(raw)
      // 禁止子路径（如 flowcast/dashboard）：即使白名单允许 flowcast，子路径也不行
      if (FORBIDDEN_FLOWCAST_SUBPATHS.some(p => raw === p || raw.startsWith(p + '/'))) {
        violations.push(raw)
        continue
      }
      if (!IMPORT_WHITELIST.has(raw) && !IMPORT_WHITELIST.has(normalized)) {
        violations.push(raw)
      }
    }
  }
  return [...new Set(violations)]
}

/**
 * 校验一个生成的 flow 文件。
 * @param {string} file
 * @param {object} [o]
 * @param {number} [o.timeout]  dry-run 子进程超时 ms（默认 60s）
 * @param {string} [o.repo]     指定 dry-run 用的 repo（默认临时 git repo，校验后清理）
 * @param {string} [o.cwd]      node 进程 cwd（决定 flowcast 解析；默认 flowcast 仓）
 * @returns {Promise<{ok:boolean, checks:string[], error?:string}>}
 */
export async function validateFlow(file, { timeout = 60_000, repo, cwd } = {}) {
  const checks = []
  const fail = (stage, msg) => ({ ok: false, checks, error: `[${stage}] ${msg}` })

  // ① 语法（生成的 flow 恒为 ESM；node --check 对无 package.json 的 .js 按 CJS 判定过松，
  //    故复制成 .mjs 再 --check，确保按 ESM 语法校验）
  const checkDir = mkdtempSync(join(tmpdir(), 'flowcast-check-'))
  const checkFile = join(checkDir, 'flow.mjs')
  try {
    copyFileSync(file, checkFile)
    execFileSync('node', ['--check', checkFile], { stdio: 'pipe' })
    checks.push('syntax')
  } catch (e) {
    return (rmSync(checkDir, { recursive: true, force: true }), fail('syntax', String(e.stderr ?? e.message).trim()))
  }
  rmSync(checkDir, { recursive: true, force: true })

  // ② import 白名单
  const bad = scanImports(readFileSync(file, 'utf8'))
  if (bad.length) return fail('imports', `非白名单 import：${bad.join(', ')}（仅允许 flowcast, util）`)
  checks.push('imports')

  // ③ 假执行器 dry-run（一次性 git repo）
  const tmp = repo ?? mkdtempSync(join(tmpdir(), 'flowcast-dryrun-'))
  const cleanupRepo = () => { if (!repo) rmSync(tmp, { recursive: true, force: true }) }
  // 加 random 后缀防止多个并发校验进程（不同测试文件平行跑）在同一毫秒内
  // 使用相同 timestamp → 共享 ~/.flowcast/dryrun/runs/dryrun-X/ → state.json.tmp 竞态
  const dryRunId = `dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // validateFlow 的 dry-run 只做冒烟校验，不需要保留 Checkpoint 状态供后续续跑。
  // 子进程退出后立即清理，防止 ~/.flowcast/dryrun/runs/ 目录随测试次数无限积累。
  const dryRunStateDir = join(process.env.HOME ?? homedir(), '.flowcast', 'dryrun', 'runs', dryRunId)
  const cleanupDryRunState = () => {
    try { if (existsSync(dryRunStateDir)) rmSync(dryRunStateDir, { recursive: true, force: true }) } catch { /* 清理失败忽略，不影响校验结果 */ }
  }
  try {
    if (!repo) {
      execFileSync('git', ['init', '-q'], { cwd: tmp })
    }
    execFileSync('node', [file, '--dry-run', '--repo', tmp, '--goal', 'dry-run-demo', '--run-id', dryRunId], {
      stdio: 'pipe',
      timeout,
      cwd,
      // 最小 env：dry-run 不调真 API，不需要任何密钥。
      // 不能继承 process.env——生成的 flow 在这里尚未经过完整信任验证，
      // 若传入真实密钥则验证沙箱形同虚设。
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
        // TMPDIR 影响 os.tmpdir()——生成的 flow 若调 mkdtempSync 需要可写的 tmp 目录
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        FLOWCAST_DRY_RUN: '1',
      },
    })
    checks.push('dry-run')
  } catch (e) {
    cleanupRepo()
    cleanupDryRunState()
    return fail('dry-run', String(e.stderr ?? e.stdout ?? e.message).trim().slice(0, 500))
  }
  cleanupRepo()
  cleanupDryRunState()
  return { ok: true, checks }
}
