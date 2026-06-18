# flowcast 效果评估框架

> **最后更新**：2026-06-18（对齐 v0.3 现状，重写自 flowx 时代旧版本）
>
> 评估核心问题：**flowcast 的三层架构（L1 执行器 / L2 原语 / L3 codegen）在真实负载下
> 可靠性如何？L3 codegen 能否稳定把自然语言需求转化为可运行的 flow？**

---

## 一、评估维度与指标

### 1. L2 原语可靠性（断点续跑、自改沙箱、质量门）

| 指标 | 定义 | 目标值 |
|---|---|---|
| 断点恢复成功率 | 中断后续跑，从正确位置继续的次数 / 总续跑次数 | ≥ 95% |
| 步骤跳过准确率 | 续跑时已完成步骤零重复执行的次数 / 总续跑次数 | 100% |
| 自改沙箱回滚成功率 | `withSelfModGuard` 出错时干净回滚的次数 / 总回滚触发次数 | 100% |
| 质量门 resume-fix 成功率 | 门红灯 → 回喂 agent 修复后再通过 / 总 resume-fix 触发次数 | ≥ 70% |
| HITL 节点响应正确率 | 用户输入后流程走向符合预期的次数 / 总 HITL 节点触发次数 | ≥ 95% |
| 非预期中断率 | 未到达 HITL 节点或正常结束而崩溃的次数 / 总运行次数 | ≤ 5% |

**数据来源**：`.flowcast/runs/*/state.json`（status 字段）、`run.log.jsonl`

---

### 2. L3 codegen 可靠性

这是当前最关键、最缺实测数据的环节。

| 指标 | 定义 | 目标值 |
|---|---|---|
| flow 一次生成成功率 | 第一次生成即通过三关校验（语法+import 白名单+dry-run）的比例 | ≥ 60% |
| flow maxAttempts=3 内成功率 | 3 次以内生成通过校验的比例 | ≥ 90% |
| flow 运行成功率 | 生成的 flow 真实执行后 exit 0 的比例 | ≥ 80% |
| `--split` 分拆质量 | 子任务数量合理（3~8 个）、描述明确的比例 | ≥ 80% |
| `--split` 并发稳定性 | fanOut 并发执行多条子 flow 无 worktree 冲突 / 总次数 | 100% |

**数据来源**：`.flowcast/runs/*/state.json`（reused/attempts 字段）、`run.log.jsonl`

---

### 3. 执行效率

| 指标 | 定义 | 数据来源 |
|---|---|---|
| 端到端总耗时 | 从 `orchestrate` 调用到 flow 执行完成 | `report.md` Total time |
| 生成阶段耗时 | `generateFlow` 调用的时长（LLM 响应时间） | `run.log.jsonl` |
| 执行阶段耗时 | flow 实际执行的时长 | `run.log.jsonl` |
| Token 消耗 | 每次 flow 的总 input/output tokens | `run.log.jsonl` inputTokens/outputTokens |

---

### 4. 使用体验

| 指标 | 定义 | 收集方式 |
|---|---|---|
| 首次上手时间 | 从安装到跑通第一个 `orchestrate` 的时间 | 用户自报 |
| 配置前置时间 | 配置好 `~/.flowcast/providers.json` + agent 的时间 | 用户自报 |
| HITL 中断率 | 用户在 HITL 节点选择不继续的次数 / 总触发次数 | `state.json` pauseReason |

---

## 二、数据收集方法

### 自动采集（已内置）

每次 flow 运行后，`.flowcast/runs/{run-id}/` 下有：

```
state.json         → status、步骤完成情况、reused、attempts
run.log.jsonl      → 每步耗时、CLI、输入输出、错误
report.md          → 可读摘要，包含总耗时和步骤表
```

orchestrate 生成的 flow 还会在 run 目录下留：

```
request.txt        → 原始需求文本
flow.mjs           → 生成的 flow 代码
```

### 批量分析命令

```bash
# 查看所有 orchestrate run 的生成尝试次数
cat .flowcast/runs/orch-*/state.json | jq -r '{runId: .runId, attempts: .attempts}'

# 查看失败的 run（生成或执行阶段）
ls .flowcast/runs/*/state.json | xargs -I{} sh -c 'jq -r "select(.status != \"completed\") | .runId + \" \" + .status" {} 2>/dev/null'

# 统计各 run 的 token 消耗
cat .flowcast/runs/*/run.log.jsonl | jq -s '[.[] | select(.inputTokens) | .inputTokens] | add'

# 看板（可视化所有 run）
flowcast dashboard --repo . --open
```

---

## 三、运行记录

> 每次真实 `orchestrate` 或 `flowcast run` 案例完成后在此追加。
> 目标：积累 5~10 次后建立基线，据此决定是否全面推广。

**当前状态：📋 待启动（真实负载冒烟尚未执行）**

| 日期 | run-id | 需求摘要 | 生成尝试次数 | flow 是否运行成功 | 总耗时 | 备注 |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | 待首次运行 |

---

## 四、评估节点

| 节点 | 触发条件 | 产出 |
|---|---|---|
| **L3 首次冒烟** | `orchestrate` 跑通 1 次真实需求（非 dry-run） | 确认生成→校验→执行链路成立 |
| **初步基线** | 累计 5 次真实 orchestrate run | flow 生成成功率基线，决定是否调高 maxAttempts 或补 few-shot |
| **可靠性评估** | 累计 20 次真实 run（含 `--split` 5 次） | 生产就绪判断、发布策略决策 |
| **优化迭代** | 某指标持续不达标 | 针对性改进 flow 骨架/FLOW_API 契约/few-shot 样例 |

---

## 五、已知差距（截至 2026-06-18）

| 差距 | 状态 |
|---|---|
| L3 codegen 真实负载从未跑过 | ⏳ P1：纳入下个 sprint |
| `--split` 多任务真实链路从未验证 | ⏳ P1：同上 |
| 断点续跑真实运行数据 = 0（全靠单测覆盖） | ⏳ P2：随真实使用自然积累 |
| EVALUATION.md 自身过时（v0.3 前为 flowx 旧叙事） | ✅ 已重写（本次） |
