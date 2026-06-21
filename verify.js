// verify.js — 对抗式验证原语（可选质量保证，**非强制环**）
//
// 对一个 claim/finding spawn 多个独立「怀疑者」agent 试图 refute 它，按阈值表决是否成立。
// 用途：审计 / bug 猎杀 / 高风险评审等「确信度关键」场景，flow 按需调用（token 偏贵）。
// 与确定性质量门（runGate 跑 test/lint/build）互补：runGate 求工程硬验证，verifyAdversarial
// 求 AI 语义共识——两者各管一类置信度，都不该硬塞进每条 flow。

import { runAgent } from './executor.js'
import { parallel } from './concurrency.js'
import { runStructured } from './schema.js'
import { isDryRun } from './dry-run.js'
import { VerifyError } from './errors.js'

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean', description: 'claim 是否经得起反驳、确实成立' },
    reason: { type: 'string', description: '简短理由' },
  },
  required: ['real', 'reason'],
}

/**
 * 对抗式验证一个 claim：多个怀疑者独立尝试反驳，达到阈值「成立票」则判定成立。
 *
 * @param {string} claim  待验证的论断 / 发现
 * @param {object} [o]
 *   - voters    怀疑者数量（默认 3）；若给了 lenses 则以 lenses 数为准
 *   - lenses    可选视角数组（如 ['correctness','security','repro']），每视角一个怀疑者，
 *               比 N 个同质怀疑者更能覆盖不同失败模式
 *   - threshold 判定成立所需的最少「成立票」（默认 = 过半）
 *   - context   附加上下文（diff / 代码片段 / 证据），拼进每个怀疑者的 prompt
 *   - agent     runAgent opts（cli/model/provider…），透传给每个怀疑者
 *   - runner    底层 runner（默认 runAgent；测试可注入 (prompt, opts)=>text）
 * @returns {Promise<{verdict:boolean, survived:number, total:number, threshold:number, votes:Array}>}
 */
export async function verifyAdversarial(claim, {
  voters = 3, lenses = null, threshold, context = '', agent = {}, runner = runAgent,
} = {}) {
  const lensList = Array.isArray(lenses) && lenses.length
    ? lenses
    : Array.from({ length: Math.max(1, voters) }, () => null)
  const need = threshold ?? Math.floor(lensList.length / 2) + 1

  // dry-run：不烧 token，返回「全票通过」让结构化 flow 能空跑骨架。
  if (isDryRun()) {
    return { verdict: true, survived: lensList.length, total: lensList.length, threshold: need, votes: [], dryRun: true }
  }

  const voterErrors = []
  const votes = await parallel(lensList.map((lens, i) => () => {
    const lensLine = lens ? `请专门从「${lens}」视角审视。` : ''
    const prompt = `你是一个严格的怀疑者，任务是尽力**反驳**下面的论断（claim）。${lensLine}
若能找到它不成立、不可靠或证据不足的理由，判 real=false；只有当它确实经得起反驳时才判 real=true。
${context ? `\n# 上下文\n${context}\n` : ''}
# Claim
${claim}`
    return runStructured((p) => runner(p, agent), prompt, { schema: VERDICT_SCHEMA })
      .then(v => ({ ...v, lens: lens ?? `voter-${i}` }))
  }), {
    // strict=false：单个 voter 因网络/限额失败时不中断整体验证。
    // 失败的 voter 在结果数组中为 null，通过 onError 记录供调用方感知。
    strict: false,
    onError: ({ index, error }) => {
      const lens = lensList[index] ?? `voter-${index}`
      console.warn(`  [verifyAdversarial] voter '${lens}' 失败（忽略）：${error.message}`)
      voterErrors.push({ lens, error: error.message })
    },
  })

  const valid = votes.filter(Boolean)
  const survived = valid.filter(v => v.real === true).length
  // 如果所有 voter 都失败（valid 为空），视为验证失败而非通过
  if (valid.length === 0) {
    throw new VerifyError(`verifyAdversarial: 所有 ${lensList.length} 个 voter 均失败，无法完成验证`, voterErrors)
  }
  return {
    verdict: survived >= need,
    survived, total: lensList.length, threshold: need, votes: valid,
    ...(voterErrors.length > 0 ? { voterErrors } : {}),
  }
}
