// errors.js — flowcast 统一错误类型层次
//
// 设计原则：
//   - FlowcastError 是所有 flowcast 抛出错误的基类（可用 instanceof 判定）
//   - 各子类通过 code 字段区分错误语义，避免解析 message 字符串
//   - isRetryable(err) 是唯一判定「是否可回退到下一 provider/CLI」的入口
//   - 原有在 error 对象上挂 .timedOut / .gate / .schemaError 等字段的代码保持向后兼容：
//     FlowcastError 子类直接赋值同名字段，instanceof 判定自然生效

// ── 基类 ─────────────────────────────────────────────────────────────

export class FlowcastError extends Error {
  /**
   * @param {string} message
   * @param {string} code  机器可读的错误码（如 'TIMEOUT' / 'GATE_FAIL' / 'SCHEMA_ERROR'）
   * @param {object} [extra]  额外字段直接赋到 this 上（向后兼容旧挂字段写法）
   */
  constructor(message, code, extra = {}) {
    super(message)
    this.name = 'FlowcastError'
    this.code = code
    Object.assign(this, extra)
  }
}

// ── 子类 ─────────────────────────────────────────────────────────────

/** spawn 超时错误（对应旧 err.timedOut = true）*/
export class TimeoutError extends FlowcastError {
  constructor(message, extra = {}) {
    super(message, 'TIMEOUT', extra)
    this.name = 'TimeoutError'
    this.timedOut = true
  }
}

/**
 * spawn 失败错误。覆盖两种场景：
 *   - spawnMsg 非空：进程无法启动（ENOENT / EACCES 等）
 *   - spawnMsg 为 null + extra.exitCode：进程启动成功但以非零码退出
 */
export class SpawnError extends FlowcastError {
  constructor(message, spawnMsg, extra = {}) {
    super(message, 'SPAWN_ERROR', extra)
    this.name = 'SpawnError'
    this.spawnError = spawnMsg  // null 时表示退出码失败，非 null 时表示进程启动失败
  }
}

/** quality gate 失败（对应旧 err.gate = name）*/
export class GateError extends FlowcastError {
  /**
   * @param {string} gateName
   * @param {number} exitCode
   * @param {string} output
   * @param {string} [detail]  可选的失败原因描述，插入消息中（如 'still failing after autofix'）
   */
  constructor(gateName, exitCode, output, detail) {
    const msg = detail
      ? `quality gate '${gateName}': ${detail} (exit ${exitCode})`
      : `quality gate '${gateName}' failed (exit ${exitCode})`
    super(msg, 'GATE_FAIL')
    this.name = 'GateError'
    this.gate = gateName
    this.exitCode = exitCode
    this.output = output
  }
}

/** schema 校验失败（对应旧 err.schemaError = msg）*/
export class SchemaError extends FlowcastError {
  constructor(message, schemaMsg) {
    super(message, 'SCHEMA_ERROR')
    this.name = 'SchemaError'
    this.schemaError = schemaMsg
  }
}

/** provider/executor 配置错误（gate configError / resolveAgent 类错误）*/
export class ConfigError extends FlowcastError {
  constructor(message) {
    super(message, 'CONFIG_ERROR')
    this.name = 'ConfigError'
    this.configError = true
  }
}

/** 路径安全校验失败（assertSafeIdent / isSafePath 失败）*/
export class PathError extends FlowcastError {
  constructor(message) {
    super(message, 'PATH_ERROR')
    this.name = 'PathError'
  }
}

/** withSelfModGuard 前置检查失败或回滚失败（guard/rollback 错误）*/
export class GuardError extends FlowcastError {
  constructor(message, code, extra) {
    super(message)
    this.name = 'GuardError'
    this.code = code || 'GUARD_FAIL'
    if (extra) Object.assign(this, extra)
  }
}

/** git 命令执行失败（err.stderr 含原始错误输出）*/
export class GitError extends FlowcastError {
  constructor(message, extra = {}) {
    super(message, 'GIT_FAIL', extra)
    this.name = 'GitError'
  }
}

/** verifyAdversarial 所有 voter 均失败时抛出（err.voterErrors 含 {lens,error} 数组）*/
export class VerifyError extends FlowcastError {
  constructor(message, voterErrors) {
    super(message, 'VERIFY_FAIL')
    this.name = 'VerifyError'
    this.voterErrors = voterErrors
  }
}

/** orchestrate 续跑锁相关错误（锁重试超限或锁被活进程持有）*/
export class LockError extends FlowcastError {
  constructor(message, code, extra) {
    super(message)
    this.name = 'LockError'
    this.code = code || 'LOCK_BUSY'
    Object.assign(this, extra)
  }
}

/** parallel() strict=true 时汇总多个子任务失败（err.failures 含 {index,error} 数组）*/
export class ParallelError extends FlowcastError {
  constructor(message, failures) {
    super(message, 'PARALLEL_FAIL')
    this.name = 'ParallelError'
    this.failures = failures
  }
}

// ── isRetryable：唯一的 provider 回退判定入口 ────────────────────────
//
// 判定逻辑：
//   1. err.timedOut = true（超时，可换 provider 重试）
//   2. err.apiStatus 是已知限额/超载码（429/529）
//   3. message 匹配限额/超载关键词（兜底，仅当无结构化字段时）
//
// 注意：此函数替代 spawn.js 的同名 isProviderRetryable。
// spawn.js 保留原函数名（向后兼容），内部委托到这里。

const RETRYABLE_PROVIDER_ERR = /rate.?limit|session limit|too many requests|quota|overloaded|\b429\b|\b529\b/i

/**
 * 判断错误是否为 provider 限额/超载/超时，可尝试切换到下一个 provider/CLI。
 * @param {any} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  if (!err) return false
  if (err.timedOut === true) return true
  if (err.apiStatus === 429 || err.apiStatus === 529) return true
  if (RETRYABLE_PROVIDER_ERR.test(err?.message ?? '')) return true
  return false
}
