import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { recordLearning, recall, buildMemorySection, promoteFailureContext } from '../memory.js'

function tempDir() { return mkdtempSync(join(tmpdir(), 'flowx-mem-')) }

test('recordLearning 落盘后可 recall 命中（按 query 关键词）', () => {
  const baseDir = tempDir()
  try {
    recordLearning('s1', { topic: 'flaky test in auth', rootCause: 'race condition', fix: 'add await', tags: ['test'] }, { baseDir })
    recordLearning('s1', { topic: 'build slow', rootCause: 'no cache', fix: 'enable cache', tags: ['build'] }, { baseDir })
    const hits = recall('s1', { query: 'auth race', topK: 5, baseDir })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].topic, 'flaky test in auth')
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})

test('recall：tag 命中权重高于正文', () => {
  const baseDir = tempDir()
  try {
    recordLearning('s', { topic: 'a', rootCause: 'mentions deploy in body', tags: [] }, { baseDir })
    recordLearning('s', { topic: 'b', rootCause: 'unrelated', tags: ['deploy'] }, { baseDir })
    const hits = recall('s', { query: 'deploy', topK: 5, baseDir })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].topic, 'b', 'tag 命中应排在正文命中之前')
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})

test('recall：无 query 返回最近优先', () => {
  const baseDir = tempDir()
  try {
    recordLearning('s', { topic: 'first' }, { baseDir })
    recordLearning('s', { topic: 'second' }, { baseDir })
    const hits = recall('s', { topK: 1, baseDir })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].topic, 'second')
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})

test('recall：scope 不存在返回空数组', () => {
  const baseDir = tempDir()
  try {
    assert.deepEqual(recall('nope', { query: 'x', baseDir }), [])
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})

test('buildMemorySection：有命中产出 markdown，无命中返回空串', () => {
  const baseDir = tempDir()
  try {
    assert.equal(buildMemorySection('s', { query: 'x', baseDir }), '')
    recordLearning('s', { topic: 'cache miss', rootCause: 'cold start', fix: 'warm up', tags: ['perf'] }, { baseDir })
    const md = buildMemorySection('s', { query: 'cache', baseDir })
    assert.match(md, /## Learnings from previous runs/)
    assert.match(md, /cache miss/)
    assert.match(md, /cold start/)
    assert.match(md, /warm up/)
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})

test('promoteFailureContext：空内容不写、返回 null；有内容沉淀进 memory', () => {
  const baseDir = tempDir()
  try {
    assert.equal(promoteFailureContext('s', null, {}, { baseDir }), null)
    const rec = promoteFailureContext('s', 'compile error: missing ;', { topic: 'attempt 1 failed', tags: ['failure', 'compile'], runId: 'r1' }, { baseDir })
    assert.notEqual(rec, null)
    assert.equal(rec.runId, 'r1')
    const hits = recall('s', { query: 'compile', baseDir })
    assert.equal(hits.length, 1)
    assert.match(hits[0].rootCause, /missing ;/)
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})

test('scope 含特殊字符被安全化为文件名（不越目录）', () => {
  const baseDir = tempDir()
  try {
    recordLearning('proj/../x', { topic: 't' }, { baseDir })
    // 不抛错且能召回即可（路径被安全化）
    const hits = recall('proj/../x', { topK: 1, baseDir })
    assert.equal(hits.length, 1)
    assert.equal(existsSync(baseDir), true)
  } finally { rmSync(baseDir, { recursive: true, force: true }) }
})
