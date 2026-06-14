import { git, gitOk } from './git.js'

// ── withSelfModGuard：自我修改安全沙箱 ⭐ ──────────────────────────
//
// 这是 recursive(self-improve.sh) 与 revengers(Self-Mod Guard) 各自独立
// 收敛到的同一个原语：让 AI 在改自己的代码时不致命。核心契约：
//   1. 跑之前要有 baseline commit，且工作树干净（否则拒绝）。
//   2. fn 抛错 / 返回 verdict='rolled-back' → 硬回滚到 baseline（reset --hard + clean）。
//   3. verdict='panic-preserved' → 保留现场不回滚（留给人诊断）。
//   4. verdict='skip-commit' → 故意留脏，不回滚。
//   5. verdict='committed' → 调用方已自行 commit，不回滚。
//
// 对应 self-improve.sh 的 git 预检 + EXIT trap + verdict_and_exit 的回滚分支。

/**
 * 捕获 baseline：要求存在 HEAD commit；requireClean 时要求工作树干净。
 * @returns {string} baseline commit sha
 */
export function captureBaseline(repo, { requireClean = true } = {}) {
  if (!gitOk(['rev-parse', '--verify', 'HEAD'], repo)) {
    throw new Error('withSelfModGuard: 无 baseline commit，请先 commit 当前状态，以便失败时回滚')
  }
  const baseline = git(['rev-parse', 'HEAD'], repo)
  if (requireClean) {
    const status = git(['status', '--porcelain'], repo)
    if (status) throw new Error(`withSelfModGuard: 工作树不干净，请先 commit/stash：\n${status}`)
  }
  return baseline
}

/**
 * 在自改安全沙箱中执行 fn。
 *
 * @param {(ctx:{repo:string,baseline:string}) => Promise<{verdict?:string}>} fn
 * @param {object} opts
 *   - repo         git 仓库根（默认 cwd）
 *   - requireClean 跑前要求工作树干净（默认 true）
 *   - baseline     显式 baseline（默认取当前 HEAD）
 *   - clean        回滚时是否 git clean -fd（默认 true）
 * @returns {Promise<{baseline:string} & fnResult>}
 */
export async function withSelfModGuard(fn, { repo = process.cwd(), requireClean = true, baseline: provided, clean = true } = {}) {
  const baseline = provided ?? captureBaseline(repo, { requireClean })

  // 复合回滚：reset --hard 必须先成功，再 clean -fd。两步任一失败 throw，
  // 末尾 status --porcelain 校验干净（处理 .gitignore 文件未被 clean 删的情况）。
  // 失败 throw 而不是 console.error，让调用方区分「rollback succeeded」vs「rollback failed mid-way」。
  const rollback = () => {
    git(['reset', '--hard', baseline], repo)
    if (clean) git(['clean', '-fd'], repo)
    const remaining = git(['status', '--porcelain'], repo)
    if (remaining) {
      throw new Error(
        `withSelfModGuard: 回滚后工作树仍脏（gitignore 文件未被 clean -fd 清除，可能影响续跑）：\n${remaining}`,
      )
    }
  }

  let result
  try {
    result = await fn({ repo, baseline })
  } catch (err) {
    // rollback 失败时不丢 fn 原 err：用 Error cause 链式带上重新抛。
    try {
      rollback()
    } catch (rollbackErr) {
      const wrapped = new Error(
        `withSelfModGuard: 回滚失败，工作树可能仍脏：${rollbackErr.message}`,
        { cause: err },
      )
      wrapped.rollbackError = rollbackErr
      throw wrapped
    }
    throw err
  }

  if (result?.verdict === 'rolled-back') {
    try {
      rollback()
    } catch (rollbackErr) {
      const wrapped = new Error(
        `withSelfModGuard: verdict=rolled-back 但回滚失败：${rollbackErr.message}`,
        { cause: rollbackErr },
      )
      throw wrapped
    }
  }
  // panic-preserved / skip-commit / committed → 不回滚
  return { baseline, ...result }
}
