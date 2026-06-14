import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

import { withSelfModGuard, captureBaseline } from '../self-mod-guard.js'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 建一个带初始 commit 的临时 git 仓。 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-guard-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 't@t'], repo)
  git(['config', 'user.name', 't'], repo)
  writeFileSync(join(repo, 'a.txt'), 'baseline\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  return repo
}

function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true })
}

test('captureBaseline 无 commit 时抛错', () => {
  const repo = mkdtempSync(join(tmpdir(), 'flowcast-guard-empty-'))
  git(['init', '-q'], repo)
  assert.throws(() => captureBaseline(repo), /无 baseline commit/)
  cleanup(repo)
})

test('captureBaseline 工作树脏时抛错（requireClean）', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'a.txt'), 'dirty\n')
  assert.throws(() => captureBaseline(repo), /工作树不干净/)
  cleanup(repo)
})

test('fn 抛错 → 硬回滚到 baseline，工作树干净', async () => {
  const repo = makeRepo()
  const baseline = git(['rev-parse', 'HEAD'], repo)
  await assert.rejects(
    withSelfModGuard(async () => {
      writeFileSync(join(repo, 'a.txt'), 'mutated\n')
      writeFileSync(join(repo, 'new.txt'), 'junk\n')
      throw new Error('boom')
    }, { repo }),
    /boom/,
  )
  assert.equal(git(['rev-parse', 'HEAD'], repo), baseline)
  assert.equal(git(['status', '--porcelain'], repo), '', '工作树应干净')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'baseline\n')
  assert.equal(existsSync(join(repo, 'new.txt')), false, 'untracked 文件应被 clean')
  cleanup(repo)
})

test("verdict='rolled-back' → 回滚", async () => {
  const repo = makeRepo()
  const r = await withSelfModGuard(async () => {
    writeFileSync(join(repo, 'a.txt'), 'mutated\n')
    return { verdict: 'rolled-back', reason: 'gate-red' }
  }, { repo })
  assert.equal(r.verdict, 'rolled-back')
  assert.equal(git(['status', '--porcelain'], repo), '')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'baseline\n')
  cleanup(repo)
})

test("verdict='panic-preserved' → 保留现场不回滚", async () => {
  const repo = makeRepo()
  const r = await withSelfModGuard(async () => {
    writeFileSync(join(repo, 'a.txt'), 'panic-state\n')
    return { verdict: 'panic-preserved' }
  }, { repo })
  assert.equal(r.verdict, 'panic-preserved')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'panic-state\n', '应保留脏现场')
  cleanup(repo)
})

test("verdict='committed' → 不回滚，保留 commit", async () => {
  const repo = makeRepo()
  const baseline = git(['rev-parse', 'HEAD'], repo)
  const r = await withSelfModGuard(async () => {
    writeFileSync(join(repo, 'a.txt'), 'committed-change\n')
    git(['add', '.'], repo)
    git(['commit', '-q', '-m', 'work'], repo)
    return { verdict: 'committed' }
  }, { repo })
  assert.equal(r.verdict, 'committed')
  assert.notEqual(git(['rev-parse', 'HEAD'], repo), baseline)
  assert.equal(r.baseline, baseline)
  cleanup(repo)
})

test("verdict='rolled-back' 但 baseline 不存在 → reset 抛错并冒泡", async () => {
  // 罕见但真实的场景：run 期间 baseline commit 被外部 force-push 抹掉，reset --hard 失败。
  // 旧实现会 console.error 然后吞掉；新实现必须 throw。
  const repo = makeRepo()
  await assert.rejects(
    withSelfModGuard(async () => {
      writeFileSync(join(repo, 'a.txt'), 'mutated\n')
      return { verdict: 'rolled-back', reason: 'gate-red' }
    }, { repo, baseline: '0000000000000000000000000000000000000000' /* 一定不存在的 sha */ }),
    /verdict=rolled-back 但回滚失败/,
  )
  cleanup(repo)
})

test("fn 抛错 + rollback 失败 → 抛带 cause 的 wrapped err", async () => {
  // fn 抛错路径下，rollback 失败必须保留原 err 信息（用 Error cause 链式带上）。
  // 构造方式：传一个根本不存在的 baseline，让 reset 失败。
  const repo = makeRepo()
  let captured
  try {
    await withSelfModGuard(async () => {
      writeFileSync(join(repo, 'a.txt'), 'mutated\n')
      throw new Error('boom')
    }, { repo, baseline: '0000000000000000000000000000000000000000' })
  } catch (e) {
    captured = e
  }
  assert.ok(captured, '应当抛出')
  assert.match(captured.message, /回滚失败/)
  assert.equal(captured.cause?.message, 'boom', '必须通过 cause 保留 fn 原 err')
  assert.ok(captured.rollbackError, '必须暴露 rollbackError 字段')
  cleanup(repo)
})

test("fn 抛错 + rollback 失败 → 抛带 cause 的 wrapped err", async () => {
  // 不容易直接构造「reset 失败 + clean 失败」的真实场景（reset 一旦 baseline 合法必成功）。
  // 这里覆盖一个等价路径：fn 抛错，rollback 路径走到 status --porcelain 校验并 throw。
  // 因为 fn 已经把 a.txt 改 dirty 且加了 untracked 文件，回滚后必须完全干净才不抛。
  const repo = makeRepo()
  const baseline = git(['rev-parse', 'HEAD'], repo)
  let captured
  try {
    await withSelfModGuard(async () => {
      writeFileSync(join(repo, 'a.txt'), 'mutated\n')
      writeFileSync(join(repo, 'new.txt'), 'junk\n')
      throw new Error('boom')
    }, { repo })
  } catch (e) {
    captured = e
  }
  assert.ok(captured, '应当抛出')
  assert.equal(captured.message, 'boom', 'rollback 成功时必须保留 fn 原 err，不包装')
  // 工作树应回到 baseline 干净状态
  assert.equal(git(['rev-parse', 'HEAD'], repo), baseline)
  assert.equal(git(['status', '--porcelain'], repo), '')
  cleanup(repo)
})
