#!/usr/bin/env node
/**
 * todo-parser.js — 解析结构化 TODO.md → 分组 JSON
 *
 * 用法（直接运行可查看分组结果）：
 *   node flows/todo-parser.js --todo <path/to/TODO.md>
 *   node flows/todo-parser.js --todo <path> --out <path/to/groups.json>
 *
 * 也可作为库导入：
 *   import { parseTodos, groupTodos } from './todo-parser.js'
 */

import { readFileSync, writeFileSync } from 'fs'
import { parseArgs } from 'util'

// ── 解析单条 TODO 条目 ──────────────────────────────────────────────

/**
 * 从 TODO.md 中解析出所有 open 条目。
 *
 * 期望格式（如 ilink-hub 的 TODO.md）：
 *   总览表：| ID | **P1** | 分类 | 简述 |
 *   条目块：
 *     ### ID · 标题
 *     - **状态**：open
 *     - **文件**：`src/foo/bar.rs:123`
 *
 * @param {string} content  TODO.md 文件内容
 * @returns {Array<TodoItem>}
 */
export function parseTodos(content) {
  // 第一步：从总览表提取 ID → severity 映射
  const severityMap = {}
  for (const line of content.split('\n')) {
    // 匹配表格行：| ID | **P1** | ... 或 | ID | P1 | ...（有无 bold 均支持）
    const tableMatch = line.match(/^\|\s*([A-Z0-9_-]+)\s*\|\s*\*{0,2}([^|*]+)\*{0,2}\s*\|/)
    if (tableMatch) {
      const id = tableMatch[1]
      const raw = tableMatch[2].toUpperCase()
      const pMatch = raw.match(/P([123])/)
      if (pMatch) severityMap[id] = `P${pMatch[1]}`
    }
  }

  const items = []
  // 按三级标题切块
  const blocks = content.split(/^### /m).slice(1)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const header = lines[0]  // "DB-01 · SQLite AnyPool ..."

    // 提取 ID 和标题
    const headerMatch = header.match(/^([A-Z0-9_-]+)\s*[·•\-]\s*(.+)$/)
    if (!headerMatch) continue
    const id = headerMatch[1]
    const title = headerMatch[2].trim()

    // 仅处理 open 状态
    const statusLine = lines.find(l => l.includes('**状态**'))
    if (!statusLine || !statusLine.includes('open')) continue

    // 提取文件路径（可能有多个，取第一个作为分组 key）
    const fileLine = lines.find(l => l.includes('**文件**'))
    const files = fileLine
      ? [...fileLine.matchAll(/`([^`]+)`/g)].map(m => m[1])
      : []

    // 严重度：优先从总览表，其次从块内文本推断
    let severity = severityMap[id] ?? 'P2'
    if (!severityMap[id]) {
      const blockSevMatch = block.match(/P([123])\b/)
      if (blockSevMatch) severity = `P${blockSevMatch[1]}`
    }

    // 提取问题描述（**问题** 或 **攻击场景** 段落）
    const descMatch = block.match(/\*\*(?:问题|攻击场景)\*\*[：:]\s*([\s\S]*?)(?=\n- \*\*|\n###|\n---|\n```|$)/)
    const description = descMatch
      ? descMatch[1].replace(/\n/g, ' ').trim().slice(0, 200)
      : ''

    // 提取修复方向
    const fixMatch = block.match(/\*\*修复方向\*\*[：:]\s*([\s\S]*?)(?=\n- \*\*|\n###|\n---|\n```|$)/)
    const fixHint = fixMatch
      ? fixMatch[1].replace(/\n/g, ' ').trim().slice(0, 300)
      : ''

    items.push({ id, title, severity, files, description, fixHint })
  }

  return items
}

// ── 分组逻辑 ──────────────────────────────────────────────────────

/**
 * 按「主文件模块」分组，把改同一个 .rs 模块的条目合并到一个 feature。
 *
 * 分组规则（优先级依次）：
 * 1. 安全类（SEC-*）P1 单独一组
 * 2. P1 可靠性（DB-*、E-*）单独一组
 * 3. 按主文件的第一级目录（src/hub → hub，src/relay → relay，src/bridge → bridge 等）分组
 * 4. 无文件标注的条目归入 misc 组
 *
 * 每组控制在 5 条以内（太多改动会超出 agent 上下文）。
 *
 * @param {Array<TodoItem>} items
 * @returns {Array<GroupDef>}
 */
export function groupTodos(items) {
  // P1 安全独立一组
  const p1sec = items.filter(i => i.severity === 'P1' && i.id.startsWith('SEC'))
  // P1 非安全独立一组
  const p1other = items.filter(i => i.severity === 'P1' && !i.id.startsWith('SEC'))

  const p2plus = items.filter(i => i.severity !== 'P1')

  // 按模块分桶
  const buckets = {}
  for (const item of p2plus) {
    const mod = detectModule(item)
    if (!buckets[mod]) buckets[mod] = []
    buckets[mod].push(item)
  }

  const groups = []

  if (p1sec.length > 0) {
    groups.push({
      name: 'security-p1',
      priority: 'P1',
      description: `P1 安全修复：${p1sec.map(i => i.id).join(', ')}`,
      items: p1sec,
    })
  }

  if (p1other.length > 0) {
    groups.push({
      name: 'reliability-p1',
      priority: 'P1',
      description: `P1 可靠性修复：${p1other.map(i => i.id).join(', ')}`,
      items: p1other,
    })
  }

  // P2/P3 按模块分组，超 5 条则拆分
  for (const [mod, modItems] of Object.entries(buckets)) {
    const chunks = chunkArray(modItems, 5)
    chunks.forEach((chunk, i) => {
      const suffix = chunks.length > 1 ? `-${i + 1}` : ''
      groups.push({
        name: `${mod}${suffix}`,
        priority: chunk[0].severity,
        description: `${mod} 模块修复：${chunk.map(c => c.id).join(', ')}`,
        items: chunk,
      })
    })
  }

  return groups
}

function detectModule(item) {
  for (const f of item.files) {
    const m = f.match(/^src\/([^/]+)/)
    if (m) return m[1]
  }
  // 按 ID 前缀猜
  if (/^SEC/.test(item.id)) return 'security'
  if (/^DB/.test(item.id)) return 'store'
  if (/^LOCK|CHAN|MEM|SYNC|TO/.test(item.id)) return 'hub'
  if (/^POLL/.test(item.id)) return 'ilink'
  if (/^MGR|B-/.test(item.id)) return 'bridge'
  if (/^API|A-/.test(item.id)) return 'server'
  return 'misc'
}

function chunkArray(arr, size) {
  const result = []
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
  return result
}

// ── 生成给 force-dev 用的 feature prompt ──────────────────────────

/**
 * 把一个分组转成 force-dev 能直接用的 feature 描述字符串。
 * 这个字符串会作为 --feature 参数传给 force-dev，也作为 prompt.md 的基础内容。
 */
export function groupToFeaturePrompt(group) {
  const itemLines = group.items.map(item => {
    const fileStr = item.files.length > 0 ? `\n     文件：${item.files.join(', ')}` : ''
    return `  - [${item.id}] ${item.title}${fileStr}
     问题：${item.description}
     修复方向：${item.fixHint}`
  }).join('\n\n')

  return `修复 ${group.description}

## 待修复条目

${itemLines}

## 完成标准
${group.items.map(i => `- [ ] ${i.id} 修复已提交，相关测试通过`).join('\n')}
- [ ] cargo clippy 无新 warning
- [ ] cargo test 全绿

## 非目标
- 不重构不涉及上述条目的其他模块
- 不升级无关依赖`
}

// ── CLI 入口 ───────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('todo-parser.js')) {
  const { values } = parseArgs({
    options: {
      todo: { type: 'string' },
      out:  { type: 'string' },
    }
  })

  if (!values.todo) {
    console.error('用法: node flows/todo-parser.js --todo <TODO.md path> [--out <groups.json>]')
    process.exit(1)
  }

  const content = readFileSync(values.todo, 'utf8')
  const items = parseTodos(content)
  const groups = groupTodos(items)

  console.log(`\n解析到 ${items.length} 条 open 条目，分为 ${groups.length} 组：\n`)
  for (const g of groups) {
    console.log(`  [${g.priority}] ${g.name}  (${g.items.length} 条)`)
    console.log(`         ${g.items.map(i => i.id).join(', ')}`)
  }

  if (values.out) {
    writeFileSync(values.out, JSON.stringify(groups, null, 2))
    console.log(`\n已写入 ${values.out}`)
  }
}
