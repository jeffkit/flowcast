#!/usr/bin/env bash
# test/run-with-retry.sh — 跑测试，遇到 Node test runner 的偶发 IPC 反序列化崩溃自动重跑。
#
# 背景：Node 的 test runner 把每个测试文件作为子进程，结果经 IPC（structuredClone）
# 回传主进程。V8 的 structuredClone 有已知偶发竞态（nodejs/node#49844、#64061），
# 表现为 "Unable to deserialize cloned data due to invalid or unsupported version"。
# --test-concurrency=1 已大幅降低概率，但在低核 CI runner 上仍偶发。
#
# 策略：跑测试 → 若失败且输出含 "deserialize"（偶发崩溃标志）→ 重跑（最多重试 N 次）。
# 真测试失败（不含 deserialize）立即退出，不浪费时间。
#
# 用法：./test/run-with-retry.sh [传给 node --test 的参数]
#   默认参数：--test --test-concurrency=1 --test-timeout=120000 test/*.test.js

set -euo pipefail

MAX_RETRIES=${FLOWCAST_TEST_RETRIES:-2}
# 默认参数与 ci.yml 的 Run tests 步骤一致
DEFAULT_ARGS=(--test --test-concurrency=1 --test-timeout=120000 test/*.test.js)

# 用第一个参数覆盖默认；否则用默认
if [ "$#" -gt 0 ]; then
  ARGS=("$@")
else
  ARGS=("${DEFAULT_ARGS[@]}")
fi

attempt=0
while [ "$attempt" -le "$MAX_RETRIES" ]; do
  attempt=$((attempt + 1))
  # 用临时文件捕获输出，便于检测偶发标志 + 失败时回显
  tmp=$(mktemp)
  # node --test 在测试失败时 exit 1；set +e 让我们能捕获退出码而非直接退出
  set +e
  node "${ARGS[@]}" >"$tmp" 2>&1
  code=$?
  set -e

  if [ "$code" -eq 0 ]; then
    # 成功：若重试过，提示一下；否则静默
    if [ "$attempt" -gt 1 ]; then
      echo "✓ 测试通过（第 $attempt 次尝试，前 $((attempt - 1)) 次为偶发崩溃已重跑）"
    fi
    rm -f "$tmp"
    exit 0
  fi

  # 失败：判断是偶发崩溃还是真失败
  if grep -q "deserialize cloned data" "$tmp"; then
    if [ "$attempt" -le "$MAX_RETRIES" ]; then
      echo "⚠ 第 $attempt 次跑测试遇到 Node test runner 偶发 IPC 崩溃（deserialize），自动重跑..." >&2
      rm -f "$tmp"
      continue
    fi
    echo "✗ 已重试 $MAX_RETRIES 次仍偶发崩溃（这是 Node/V8 已知 bug，非测试代码问题）。" >&2
    echo "  最后一次输出见上。可重跑 CI 或设 FLOWCAST_TEST_RETRIES 加大重试次数。" >&2
    cat "$tmp"
    rm -f "$tmp"
    exit 1
  fi

  # 真测试失败：回显输出并退出，不重试
  cat "$tmp"
  rm -f "$tmp"
  exit 1
done
