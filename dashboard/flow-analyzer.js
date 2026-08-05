// dashboard/flow-analyzer.js — flow 文件的 AST 静态分析原语。
//
// 用 acorn 解析 ESM 源码，用 acorn-walk 的 ancestor 遍历提取 cp.step() / loop() /
// parallel() / fanOut() 的结构。零副作用（不执行 flow），失败也只是返回 parseError。
//
// 关键设计：dry-run 只能看到一条执行路径（动态生成的 step 实例数取决于运行时）；
// AST 能看到完整的"结构意图"——所有字面量 step key + 控制流嵌套 + 函数作用域。

import { parse } from 'acorn'

const STEP_METHOD = 'step'
const GROUP_FUNCS = new Set(['loop', 'parallel', 'fanOut'])

/**
 * 静态分析一个 flow 文件的源码。
 *
 * @param {string} source  flow 文件源码
 * @param {string} [filePath]  仅用于错误信息展示
 * @returns {{
 *   steps: Array<{
 *     key: string, dynamic: boolean, template: string | null,
 *     line: number, scope: string,
 *     inLoop: boolean, inLoopKind: 'for'|'while'|'loop()'|null,
 *     inParallelDepth: number, inFanOut: boolean,
 *   }>,
 *   groups: Array<{
 *     type: 'loop'|'parallel'|'fanOut',
 *     line: number, lineEnd: number, scope: string,
 *     childStepIndexes: number[],
 *   }>,
 *   parseError: null | { message: string, line: number, column: number },
 * }}
 */
export function analyzeFlow(source, filePath = '<flow>') {
  let ast
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowReturnOutsideFunction: false,
      allowAwaitOutsideFunction: false,
    })
  } catch (e) {
    return {
      steps: [],
      groups: [],
      parseError: {
        message: e.message,
        line: e.loc?.line ?? 0,
        column: e.loc?.column ?? 0,
      },
    }
  }

  const steps = []
  const groups = []
  const branches = []
  const calls = []

  // ── 手动祖先遍历 ──
  walkWithAncestors(ast, [], source, steps, groups, branches, calls, null, [])

  // ── Pass 2：把 group 的 childStepIndexes 填上 ──
  // group 在源码里跨越一段行范围；其 arg 内部的 thunk 内的 step 已按 <anonymous> scope
  // 被收录进 steps。匹配规则：step 的 line 在 group 的 [line, lineEnd] 范围内，
  // 且 step 不是 group 调用本身（group 通常嵌套在 cp.step 里，那个外层 step 不算）。
  for (const g of groups) {
    g.childStepIndexes = []
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      // 行范围匹配（不再要求 scope 不同——loop 的 thunk 是 lambda，scope 就是 <anonymous>）
      if (s.line >= g.line && s.line <= g.lineEnd) {
        g.childStepIndexes.push(i)
      }
    }
  }
  // 过滤：for/while 循环 group 若不含任何 step（空循环 / 循环内无 cp.step），
  // 不保留——避免图被大量空容器塞满。loop()/parallel()/fanOut() 保留（可能只有 actions）。
  const filteredGroups = groups.filter(g => {
    if (g.type === 'for' || g.type === 'while') return g.childStepIndexes.length > 0
    return true
  })

  return { steps, groups: filteredGroups, branches, calls, parseError: null }
}

/** 判断 AST 节点是否是 for/while 循环语句，返回 group 类型（'for' | 'while' | null）。 */
function detectLoopStatement(node) {
  if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    return 'for'
  }
  if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') {
    return 'while'
  }
  return null
}

/**
 * 手动 DFS 遍历 ESTree AST。
 *
 * 设计：维护完整 ancestor 链，所有节点都下钻（包括函数节点内部）。
 *  - 每次递归把当前 node 加进 ancestors → 走到 cp.step() 时 ancestors 含完整路径
 *  - nearestFunctionScope 从 ancestors 里找最近的具名函数（识别 var lambda = () => 模式）
 *  - classifyBranch 扫描祖先链找 for/while/loop()/parallel()/fanOut
 *  - ifContext 跟踪 if/else 分支方向（consequent → 'then'，alternate → 'else'）
 *  - ifStack 跟踪嵌套 if 分支栈，step 归入最近的 if 分支
 *
 * @param {object} node        当前 AST 节点
 * @param {object[]} ancestors 祖先链
 * @param {string} source      源码
 * @param {object[]} steps     输出：step 列表
 * @param {object[]} groups    输出：group 列表
 * @param {object[]} branches  输出：if 分支列表
 * @param {object[]} calls     输出：函数调用图（caller → callee）
 * @param {string|null} ifContext  当前 if 分支方向（'then' | 'else' | null）
 * @param {object[]} ifStack   嵌套 if 分支栈（每个元素 { branch, side }）
 */
function walkWithAncestors(node, ancestors, source, steps, groups, branches, calls, ifContext = null, ifStack = []) {
  if (!node || typeof node.type !== 'string') return

  // 处理 CallExpression（当前节点可能是 step 调用或 group 调用）
  if (node.type === 'CallExpression') {
    const stepInfo = detectStepCall(node, source)
    if (stepInfo) {
      const scope = nearestFunctionScope(ancestors)
      const ctx = classifyBranch(ancestors)
      // 穿透：扫描 step 参数 lambda 内的 parallel/loop/fanOut 调用
      const callbackGroups = scanCallbackGroups(node, source)
      const stepIndex = steps.length
      steps.push({
        key: stepInfo.key,
        dynamic: stepInfo.dynamic,
        template: stepInfo.template,
        line: node.loc?.start?.line ?? 0,
        scope,
        inLoop: ctx.inLoop || callbackGroups.includes('loop'),
        inLoopKind: ctx.inLoopKind ?? (callbackGroups.includes('loop') ? 'loop()' : null),
        inParallelDepth: ctx.inParallelDepth + (callbackGroups.includes('parallel') ? 1 : 0),
        inFanOut: ctx.inFanOut || callbackGroups.includes('fanOut'),
        inIf: ifContext !== null,
        inIfBranch: ifContext,  // 'then' | 'else' | null
      })
      // 归入最近的 if 分支（若在 if 内）
      if (ifStack.length > 0) {
        const top = ifStack[ifStack.length - 1]
        if (top.side === 'then') top.branch.thenSteps.push(stepIndex)
        else if (top.side === 'else') top.branch.elseSteps.push(stepIndex)
      }
    } else {
      const groupType = detectGroupCall(node)
      if (groupType) {
        groups.push({
          type: groupType,
          line: node.loc?.start?.line ?? 0,
          lineEnd: node.loc?.end?.line ?? 0,
          scope: nearestFunctionScope(ancestors),
          childStepIndexes: [],
          actions: scanGroupActions(node),
        })
      }
      // 检测 helper 函数调用（用于层次化：子流程节点）
      const callInfo = detectHelperCall(node)
      if (callInfo) {
        calls.push({
          caller: nearestFunctionScope(ancestors),
          callee: callInfo.name,
          line: node.loc?.start?.line ?? 0,
        })
      }
    }
  }

  // 把当前 node 加进 ancestors → 进入子节点时祖先链完整
  const newAncestors = [...ancestors, node]
  // For/While 语句：建循环 group（type='for' | 'while'）
  // 注意：group 在 Pass 2 才填 childStepIndexes，这里先建占位。
  const loopGroupType = detectLoopStatement(node)
  if (loopGroupType) {
    groups.push({
      type: loopGroupType,
      line: node.loc?.start?.line ?? 0,
      lineEnd: node.loc?.end?.line ?? 0,
      scope: nearestFunctionScope(ancestors),
      childStepIndexes: [],
      actions: [],
    })
  }
  // IfStatement：建分支压栈，consequent 传 'then'，alternate 传 'else'
  if (node.type === 'IfStatement') {
    const branch = { type: 'if', line: node.loc?.start?.line ?? 0, lineEnd: node.loc?.end?.line ?? 0, thenSteps: [], elseSteps: [] }
    branches.push(branch)
    // consequent → then 分支
    const thenStack = [...ifStack, { branch, side: 'then' }]
    walkChildren(node, newAncestors, source, steps, groups, branches, calls, ['consequent'], 'then', thenStack)
    // alternate → else 分支（可能为 null）
    if (node.alternate) {
      const elseStack = [...ifStack, { branch, side: 'else' }]
      walkChildren(node, newAncestors, source, steps, groups, branches, calls, ['alternate'], 'else', elseStack)
    }
    // test 表达式无分支上下文
    walkChildren(node, newAncestors, source, steps, groups, branches, calls, ['test'], ifContext, ifStack)
    return
  }
  const keys = getChildKeys(node)
  walkChildren(node, newAncestors, source, steps, groups, branches, calls, keys, ifContext, ifStack)
}

/** 通用子节点下钻。 */
function walkChildren(node, ancestors, source, steps, groups, branches, calls, keys, ifContext = null, ifStack = []) {
  for (const key of keys) {
    const child = node[key]
    // VariableDeclarator 分发 init 时把自己加进 ancestors（让 arrow 内的 step
    // 通过 VariableDeclarator.id 拿到变量名作为 scope）。
    const childAncestors = (node.type === 'VariableDeclarator' && key === 'init')
      ? [...ancestors, node]
      : ancestors
    if (Array.isArray(child)) {
      for (const c of child) walkWithAncestors(c, childAncestors, source, steps, groups, branches, calls, ifContext, ifStack)
    } else if (child && typeof child.type === 'string') {
      walkWithAncestors(child, childAncestors, source, steps, groups, branches, calls, ifContext, ifStack)
    }
  }
}

/** ESTree 节点上的子节点 key 列表（要遍历的属性）。 */
function getChildKeys(node) {
  switch (node.type) {
    case 'Program': return ['body']
    case 'BlockStatement': return ['body']
    case 'ExpressionStatement': return ['expression']
    case 'IfStatement': return ['test', 'consequent', 'alternate']
    case 'ForStatement': return ['init', 'test', 'update', 'body']
    case 'ForInStatement': case 'ForOfStatement': return ['left', 'right', 'body']
    case 'WhileStatement': case 'DoWhileStatement': return ['test', 'body']
    case 'SwitchStatement': return ['discriminant', 'cases']
    case 'SwitchCase': return ['test', 'consequent']
    case 'TryStatement': return ['block', 'handler', 'finalizer']
    case 'CatchClause': return ['param', 'body']
    case 'FunctionDeclaration': case 'FunctionExpression':
      return ['id', 'params', 'body']
    case 'ArrowFunctionExpression':
      return ['params', 'body']
    case 'VariableDeclarator': return ['id', 'init']
    case 'VariableDeclaration': return ['declarations']
    case 'AssignmentExpression': case 'BinaryExpression':
    case 'LogicalExpression': case 'MemberExpression':
      return ['left', 'right']
    case 'UnaryExpression': case 'UpdateExpression': return ['argument']
    case 'ConditionalExpression': return ['test', 'consequent', 'alternate']
    case 'CallExpression': case 'NewExpression':
      return ['callee', 'arguments']
    case 'ArrayExpression': case 'ArrayPattern': return ['elements']
    case 'ObjectExpression': case 'ObjectPattern':
      return ['properties']
    case 'Property': return ['key', 'value']
    case 'SpreadElement': case 'RestElement': return ['argument']
    case 'TemplateLiteral': return ['expressions', 'quasis']
    case 'TaggedTemplateExpression': return ['tag', 'quasi']
    case 'ReturnStatement': case 'YieldExpression': return ['argument']
    case 'ThrowStatement': return ['argument']
    case 'AwaitExpression': return ['argument']
    case 'ImportDeclaration': return ['specifiers', 'source']
    case 'ImportSpecifier': case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier': return ['imported', 'local']
    case 'ExportNamedDeclaration': return ['declaration', 'specifiers', 'source']
    case 'ExportDefaultDeclaration': return ['declaration']
    case 'SequenceExpression': return ['expressions']
    case 'LabeledStatement': return ['body']
    default: return []
  }
}

// ── 检测函数 ──────────────────────────────────────────────────────

/**
 * 检测是否是 cp.step(...) / checkpoint.step(...) / this.step(...) 调用。
 * 宽松匹配：callee 是 MemberExpression 且 property.name === 'step'，第一个参数是字面量。
 */
function detectStepCall(node, source) {
  if (node.type !== 'CallExpression' || node.arguments.length === 0) return null
  const callee = node.callee
  if (callee.type !== 'MemberExpression') return null
  if (callee.computed) return null
  if (callee.property.name !== STEP_METHOD) return null

  const firstArg = node.arguments[0]
  // 字面量字符串
  if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') {
    return { key: firstArg.value, dynamic: false, template: null }
  }
  // 模板字符串（含表达式）→ 动态。template 字段去掉反引号，用 ${} 包裹表达式，
  // 让前端显示干净（`sprint-${i+1}` → sprint-${i+1}）。
  if (firstArg.type === 'TemplateLiteral' && firstArg.expressions.length > 0) {
    const parts = []
    firstArg.expressions.forEach((expr, i) => {
      parts.push(firstArg.quasis[i].value.cooked)
      parts.push(`\${${sourceSlice(source, expr)}}`)
    })
    parts.push(firstArg.quasis[firstArg.quasis.length - 1].value.cooked)
    return {
      key: parts.join('').replace(/\?/g, ''),
      dynamic: true,
      template: parts.join(''),
    }
  }
  // 其他（变量、表达式）→ 动态但无模板
  if (firstArg.type !== 'TemplateLiteral') {
    return {
      key: sourceSlice(source, firstArg).slice(0, 80),
      dynamic: true,
      template: null,
    }
  }
  // TemplateLiteral 无表达式（`'static'`）→ 静态
  if (firstArg.type === 'TemplateLiteral' && firstArg.expressions.length === 0) {
    return { key: firstArg.quasis[0].value.cooked, dynamic: false, template: null }
  }
  return null
}

/** 检测是否是 loop() / parallel() / fanOut() 的直接调用。 */
function detectGroupCall(node) {
  if (node.type !== 'CallExpression') return null
  if (node.callee.type !== 'Identifier') return null
  return GROUP_FUNCS.has(node.callee.name) ? node.callee.name : null
}

// 内置/工具函数黑名单——这些不算 helper 调用（不是子流程）
const HELPER_NOISE = new Set([
  // flowcast 原语
  'step', 'loop', 'parallel', 'fanOut', 'runAgent', 'runAgentChain',
  'runGate', 'runGates', 'runStructured', 'notify', 'setHitlBackend',
  'captureBaseline', 'gitCreateBranch', 'gitCommitAll', 'gitWorktreeAdd',
  'gitWorktreeRemove', 'setWorkdir', 'resolveAgent',
  'loadAgents', 'loadProviders', 'loadGates', 'mergeGates',
  'flowcastDir', 'isDryRun', 'Checkpoint',
  // Node 内置 / 工具
  'require', 'import', 'parseArgs', 'console', 'log', 'error', 'warn',
  'process', 'Math', 'JSON', 'String', 'Number', 'Object', 'Array',
  'Promise', 'Boolean', 'Date', 'parseInt', 'parseFloat', 'isNaN',
  'read', 'write', 'readFileSync', 'writeFileSync', 'existsSync',
  'mkdirSync', 'readdirSync', 'copyFileSync', 'unlinkSync', 'renameSync',
  'execFileSync', 'spawnSync', 'spawn', 'join', 'resolve', 'dirname',
  'basename', 'extname', 'normalize', 'relative', 'isAbsolute',
  'realpathSync', 'statSync', 'tmpdir', 'homedir', 'pathToFileURL',
  'fileURLToPath', 'hmac', 'randomBytes', 'createHash',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'git', 'killProcessTree', 'pgrepAll', 'ensureGitExclude',
  'killStaleRecursiveProcs', 'preserveScene', 'emitEvent',
  'assertGatePrereqs', 'pingProvider', 'buildEnv', 'reviewWithRetry',
  'readRunGoal', 'readFailureLog', 'countTranscriptMessages',
  'goalSubject', 'normalizeGate', 'runGateWithWatchdog', 'recursive',
])

/**
 * 检测 helper 函数调用（用于层次化渲染的"子流程节点"）。
 * 只收项目自定义的具名函数调用（排除内置/工具/flowcast 原语）。
 */
function detectHelperCall(node) {
  if (node.type !== 'CallExpression') return null
  if (node.callee.type !== 'Identifier') return null
  const name = node.callee.name
  // 排除：以小写字母开头的常见工具函数 + 黑名单
  if (HELPER_NOISE.has(name)) return null
  // 只收看起来像"业务函数"的调用：驼峰命名、长度 > 3
  if (!/^[a-z][a-zA-Z0-9]{3,}$/.test(name)) return null
  return { name }
}

/**
 * 从祖先链找出最近的具名函数 scope。
 * 函数声明 / 命名函数表达式 / var name = arrowFn 都能拿到名字；匿名箭头 → '<anonymous>'；都没 → 'module'。
 */
function nearestFunctionScope(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]
    if (a.type === 'FunctionDeclaration' && a.id?.name) return a.id.name
    if (a.type === 'FunctionExpression' && a.id?.name) return a.id.name
    if (a.type === 'ArrowFunctionExpression') {
      // 仅当 arrow 是 VariableDeclarator 的 init（直接父链）时才算名字。
      // 往前找最近的 VariableDeclarator，且它必须"包含"这个 arrow——
      // 通过检查 ancestors 里 arrow 到 VariableDeclarator 之间有没有其他函数边界
      // 来避免把不相干的变量声明当成名字。
      for (let j = i - 1; j >= 0; j--) {
        const p = ancestors[j]
        // 遇到函数边界就停（arrow 嵌套在别的函数里时不要串出去）
        if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' ||
            p.type === 'ArrowFunctionExpression') {
          break
        }
        if (p.type === 'VariableDeclarator' && p.id?.type === 'Identifier') {
          return p.id.name
        }
      }
      return '<anonymous>'
    }
  }
  return 'module'
}

/** 找出 step 所在控制流上下文（for/while/loop()/parallel()/fanOut）。 */
function classifyBranch(ancestors) {
  let inLoop = false
  let inLoopKind = null
  let inParallelDepth = 0
  let inFanOut = false
  for (const a of ancestors) {
    if (a.type === 'ForStatement' || a.type === 'ForInStatement' || a.type === 'ForOfStatement') {
      inLoop = true; if (!inLoopKind) inLoopKind = 'for'
    }
    if (a.type === 'WhileStatement' || a.type === 'DoWhileStatement') {
      inLoop = true; if (!inLoopKind) inLoopKind = 'while'
    }
    if (a.type === 'CallExpression' && a.callee?.type === 'Identifier') {
      const name = a.callee.name
      if (name === 'parallel') inParallelDepth++
      else if (name === 'fanOut') inFanOut = true
      else if (name === 'loop') { inLoop = true; if (!inLoopKind) inLoopKind = 'loop()' }
    }
  }
  return { inLoop, inLoopKind, inParallelDepth, inFanOut }
}

/**
 * 扫描 step 调用的参数 lambda，检测其内部是否有 parallel()/loop()/fanOut() 调用。
 * 场景：`cp.step('analyze', () => parallel([...]))` —— parallel 在 step 的第二个参数
 * lambda 内，不在 step 的祖先链上。穿透这个 lambda 才能标出 step 的并行语义。
 *
 * @param {object} callNode  cp.step(...) 的 CallExpression 节点
 * @param {string} source    源码（用不到，但保持签名一致）
 * @returns {string[]} 检测到的 group 类型：['parallel'] | ['loop'] | ['fanOut'] | 组合
 */
function scanCallbackGroups(callNode, source) {
  const found = new Set()
  // 扫描所有参数（通常是 args[1] 的 lambda），找 group 函数调用
  for (const arg of callNode.arguments) {
    scanNodeForGroups(arg, found)
  }
  return [...found]
}

/** 递归扫一个节点子树，找 parallel/loop/fanOut 的直接调用（不深挖嵌套函数）。 */
function scanNodeForGroups(node, found) {
  if (!node || typeof node.type !== 'string') return
  if (node.type === 'CallExpression') {
    if (node.callee?.type === 'Identifier' && GROUP_FUNCS.has(node.callee.name)) {
      found.add(node.callee.name)
    }
  }
  // 只下钻一层"简单结构"：对象/数组/箭头函数 body——避免无限递归
  const keys = getChildKeys(node)
  for (const key of keys) {
    if (key === 'body' && node.type === 'ArrowFunctionExpression') {
      // 下钻 arrow body 找 group 调用
      const b = node.body
      if (Array.isArray(b)) for (const x of b) scanNodeForGroups(x, found)
      else if (b && typeof b.type === 'string') scanNodeForGroups(b, found)
      continue
    }
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) scanNodeForGroups(c, found)
    } else if (child && typeof child.type === 'string') {
      scanNodeForGroups(child, found)
    }
  }
}

// group 参数 lambda 内部的动作提取：黑名单（噪音函数/关键字）
const ACTION_NOISE = new Set([
  'read', 'write', 'console', 'log', 'error', 'warn',
  'process', 'require', 'import', 'parseArgs', 'Math', 'JSON',
  'String', 'Number', 'Object', 'Array', 'Promise', 'Boolean',
  'Date', 'parseInt', 'parseFloat', 'isNaN', 'typeof', 'delete',
  'async', 'await', 'return', 'if', 'else', 'for', 'while',
  'catch', 'finally', 'new', 'throw', 'yield', 'of', 'in',
  'try', 'switch', 'case', 'default', 'do', 'continue', 'break',
  'void', 'instanceof', 'typeof', 'function', 'const', 'let', 'var',
  'push', 'map', 'filter', 'reduce', 'forEach', 'includes', 'join',
  'split', 'slice', 'trim', 'toString', 'hasOwnProperty', 'keys',
  'values', 'entries', 'length', 'git', 'execFileSync', 'spawnSync',
  'existsSync', 'mkdirSync', 'readdirSync', 'readFileSync', 'writeFileSync',
])

/**
 * 提取 group（loop/parallel/fanOut）参数 lambda 内部的具名函数调用，
 * 用于在容器内展示"这个组在做什么"（如 runProfile / runGate 等业务动作）。
 *
 * @param {object} callNode  group 调用的 CallExpression 节点
 * @returns {Array<{ name: string, line: number }>}
 */
function scanGroupActions(callNode) {
  const actions = []
  const seen = new Set()  // 去重（同名同行）
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
      const name = node.callee.name
      const line = node.loc?.start?.line ?? 0
      const key = `${name}:${line}`
      if (!ACTION_NOISE.has(name) && !seen.has(key)) {
        seen.add(key)
        actions.push({ name, line })
      }
    }
    const keys = getChildKeys(node)
    for (const k of keys) {
      const c = node[k]
      if (Array.isArray(c)) for (const x of c) walk(x)
      else if (c && typeof c.type === 'string') walk(c)
    }
  }
  for (const arg of callNode.arguments) walk(arg)
  return actions
}

function sourceSlice(source, node) {
  if (typeof node.start !== 'number') return ''
  return source.slice(node.start, node.end)
}