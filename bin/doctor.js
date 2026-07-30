// bin/doctor.js — `flowcast doctor`：环境健康自检（只读，不写盘）。
//
// 用法：
//   flowcast doctor              全面自检当前环境
//   flowcast doctor --repo .     额外检查 <repo>/.flowcast 配置与 flowcast 包可解析性
//
// 检查项：
//   1. 运行时：Node ≥20？git 可用？
//   2. agent CLI：每个内置 CLI 的 PATH / 凭证状态
//   3. 配置合法性：~/.flowcast + <repo>/.flowcast 的 agents/providers 是否可解析、${ENV} 是否能展开
//   4. flowcast 包可解析性（--repo 时）
// 每条 ✗ 给具体修复建议。退出码：全绿 0，有问题 1。

import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { fullScan } from '../scan.js'
import { basenamesFor } from '../provider.js'

// 一个检查项：{ ok, label, detail?, fix?, warn? }
//   ok=true  → ✓（通过）
//   ok=false → ✗（致命，影响退出码）
//   warn=true 且 ok=true → ⚠️（提示，不影响退出码）
function check(label, ok, { detail, fix, warn = false } = {}) {
  return { label, ok, detail, fix, warn }
}

function nodeVersionOk() {
  const major = parseInt(process.versions.node.split('.')[0], 10)
  return check(`Node.js ≥ 20（当前 ${process.versions.node}）`, major >= 20, {
    fix: '升级 Node：用 nvm install 20 或 fnm use 20',
  })
}

function gitOk() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' })
  const ok = r.status === 0
  return check('git 可用', ok, {
    detail: ok ? r.stdout.trim() : undefined,
    fix: '安装 git：brew install git / apt install git',
  })
}

function renderCliRow(a) {
  const mark = (b) => b === true ? '✓' : b === false ? '✗' : '?'
  const status = a.installed
    ? (a.authed === false ? '已装·未登录' : a.authed === true ? '已装·已登录' : '已装·凭证未知')
    : '未安装'
  return check(`${a.cli}（${a.executor ?? '-'}）`, a.ready, {
    detail: a.installed ? `${status} — ${a.authDetail}` : 'PATH 中未找到',
    fix: a.installed
      ? (a.authed === false ? `登录该 CLI 或设置对应凭证/env` : undefined)
      : `安装 ${a.cli} CLI`,
  })
}

function configChecks(config) {
  const checks = []
  for (const prob of config.agentProblems) {
    checks.push(check(`agent '${prob.agent}' 配置`, false, {
      detail: prob.problems.join('; '),
      fix: '修正 ~/.flowcast/agents.json 或运行 flowcast init 重新生成',
    }))
  }

  // 算出「被某个 agent profile 引用的 provider 名集合」。
  // 未被引用的 provider 即使 ${ENV} 展不开，也只是「暂时用不到」，降级为 ⚠️ 提示而非致命 ✗。
  // 否则用户配了多个 provider、当前只打算用其中一两个时，doctor 会刷一屏红叉并退出码 1。
  const referenced = new Set(
    Object.values(config.agents || {})
      .map(a => a && a.provider)
      .filter(Boolean)
  )
  for (const prob of config.providerProblems) {
    const used = referenced.has(prob.provider)
    checks.push(check(`provider '${prob.provider}' 配置`, used ? false : true, {
      detail: prob.problems.join('; ') + (used ? '' : '（未被任何 agent 引用，暂不影响使用）'),
      fix: used ? '设置缺失的环境变量，或修正 providers.json 里的 ${ENV}' : '用到时再设置该环境变量',
      warn: !used,
    }))
  }
  return checks
}

function configExistenceChecks() {
  const home = homedir()
  const checks = []
  for (const dir of [join(home, '.flowcast'), join(home, '.flowx')]) {
    if (!existsSync(dir)) continue
    for (const stem of ['agents', 'providers']) {
      for (const base of basenamesFor(stem)) {
        if (existsSync(join(dir, base))) {
          checks.push(check(`${dir}/${base} 存在`, true, {}))
        }
      }
    }
  }
  return checks
}

/**
 * 运行 `flowcast doctor`。
 * @param {string[]} argv
 * @param {object} [injected]  测试用：{ scan, out }
 * @returns {Promise<number>}  退出码（0=全绿，1=有问题）
 */
export async function runDoctor(argv = [], injected = {}) {
  const withRepo = argv.includes('--repo') || argv.some(a => a === '--repo')
  const repoIdx = argv.indexOf('--repo')
  const repo = withRepo && repoIdx >= 0 && argv[repoIdx + 1] ? argv[repoIdx + 1] : process.cwd()
  const { out = process.stdout } = injected

  const groups = []

  // 1. 运行时
  groups.push({ title: '运行时', items: [nodeVersionOk(), gitOk()] })

  // 2. 扫描
  const scanResult = injected.scan ?? await fullScan({ repo })
  const cliItems = scanResult.agents.map(renderCliRow)
  groups.push({ title: `agent CLI（${scanResult.summary.installedClis}/${scanResult.summary.totalClis} 已装）`, items: cliItems })

  // 3. 配置
  const cfgItems = [
    ...configExistenceChecks(),
    ...configChecks(scanResult.config),
  ]
  if (cfgItems.length === 0) {
    cfgItems.push(check('配置文件', true, { detail: '未发现配置文件（可用 flowcast init 生成）' }))
  }
  groups.push({ title: '配置合法性', items: cfgItems })

  // 4. flowcast 包可解析性
  if (withRepo) {
    groups.push({
      title: 'flowcast 包可解析性',
      items: [check('当前 repo 能解析 flowcast', scanResult.flowcastResolvable.ok, {
        detail: scanResult.flowcastResolvable.ok ? undefined : scanResult.flowcastResolvable.error,
        fix: scanResult.flowcastResolvable.ok ? undefined : 'cd <repo> && npm install flowcast',
      })],
    })
  }

  // 渲染
  let allOk = true
  for (const g of groups) {
    out.write(`\n【${g.title}】\n`)
    for (const it of g.items) {
      const mark = it.warn ? '⚠' : (it.ok ? '✓' : '✗')
      out.write(`  ${mark} ${it.label}\n`)
      if (it.detail) out.write(`      ${it.detail}\n`)
      if (!it.ok) {
        allOk = false
        if (it.fix) out.write(`      → 修复：${it.fix}\n`)
      }
    }
  }

  out.write('\n')
  if (allOk) {
    out.write('✓ 环境就绪，可以开跑了：flowcast orchestrate "<需求>" --repo .\n')
    return 0
  }
  out.write('✗ 有问题需要处理（见上方 ✗ 项）。提示：flowcast init 可自动生成配置。\n')
  return 1
}
