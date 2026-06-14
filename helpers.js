// helpers.js — 跨模块复用的纯函数 / 校验器。
//
// 任何模块要校验"任务标识符"（task.name / failure-context tag / 子 runId 等）
// 都要走 assertSafeIdent。理由：这些字符串最终拼到文件路径里，
// path.join 不阻止 `..` 解析，必须用白名单字符校验拦在源头。

// 标识符白名单：字母数字开头结尾，中间允许 . _ -
// （跟 subflow.js 原本内联的正则一致，提出来共享）
const IDENT_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

/**
 * 校验任务/资源标识符。
 * @param {string} name
 * @param {string} [field='name']  出错信息里用的字段名
 * @throws {Error} 不安全字符
 */
export function assertSafeIdent(name, field = 'name') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(
      `${field} '${name}' contains unsafe characters. ` +
      `Only alphanumeric, dots, dashes, and underscores are allowed, ` +
      `and must start/end with alphanumeric.`,
    )
  }
  return name
}