# 借鉴笔记：dsh workflow/subagent 设计中值得 flowcast 吸收的东西

- 日期：2026-08-16
- 性质：设计借鉴清单（与 [ADR-2026-08-16-dsh-workflow-layering.md](./ADR-2026-08-16-dsh-workflow-layering.md) 的"不内嵌"决策独立——借鉴设计，不合并运行时）
- 来源：dsh 0.1.0-rc.5/6 源码（`packages/workflow/*`、`packages/subagent/*`）实测阅读

定位差异先立住：dsh 是 agent 内部编排，flowcast 是**各种 agent 之上**的编排。下面的借鉴全部服务于"把上层编排做得更强"，不是复制 dsh。

---

## 1. 动态脚本编排面（最大的一笔）

**dsh 的设计**：`workflow` 工具让模型写一段**受限内联脚本**——只有五个钩子（`agent(prompt, {label, phase, schema, model})` / `parallel(thunks)` / `pipeline(items, ...stages)` / `phase(title)` / `log(msg)`），无 timers/fs/Node globals，结果必须是纯 JSON，meta（name/description）由宿主携带而非脚本声明，`maxTotalAgents` 等预算对脚本不可见。执行体不是 spawn CLI，是宿主 subagent。

**flowcast 现状**：`orchestrate` 走 L3 codegen——agent 生成完整 flow 文件再执行。能力强但重：有文件落盘、有审查/校验环节、适合"认真规划的大活"。

**借鉴**：新增一个**轻量动态脚本 API**（工作名 `runScript(script, {meta, args})`）：

- 同样的五钩子受限面（钩子落 flowcast 原语：`agent` → `runAgent` + 每调用一个 `cp.step`、`parallel`/`pipeline` → concurrency.js、`phase`/`log` → `cp.event`）
- **每钩子调用 checkpoint**——这是我们对 dsh 该面的直接优势：dsh 的脚本没有 journaling，我们的有
- meta 校验先于执行（name/description 必填、未知字段拒绝）、parse-check 同步失败
- 与 orchestrate 的分工：runScript 管"对话内即时编排"（模型当场写、当场跑、可续跑），orchestrate 管"成档 flow 工程"。对应 dsh 文档那句话的精神——"只在用户明确要 workflow/大规模编排时用"，普通一两步继续直接 runAgent

**执行隔离**（borrow worker-thread 的工程细节）：脚本跑在空环境 worker（`process.env` 不带环境凭据）、structured-clone 数据边界、ready/go 握手防"启动即取消"竞态、`terminate()` 兜底失控同步循环。**同时 borrow 它的诚实声明**：这是工程隔离不是安全沙箱，模型脚本等同 bash 信任级——我们文档要写一样的话。

## 2. 总量预算词汇（budget vocabulary）

**dsh**：`maxTotalAgents`（整个 run 的子 agent 总预算）+ ITEM_CAP + 并发上限，三层独立；预算对脚本不可见。

**flowcast**：有并发上限（parallel/pipeline 的 concurrency、CPU 默认）、loop 有 maxTurns/maxRuntimeMs——但没有**贯穿 run 的 agent 总量预算**。

**借鉴**：`cp` 或 run 级 `maxTotalAgents`，parallel/pipeline/loop 共同消费；超预算是 fatal（对照 dsh 的 AGENT_CAP 错误码纪律：fatal 错误必须逃逸 parallel 而不是变成单项 null）。

## 3. stopReason 规范枚举 +「不干净不算成功」

**dsh**：stop reason 词汇封闭（completed / max-tokens / aborted / error），映射纪律明确——"everything else maps to error, so **an unclean stop is never reported as success**"。

**flowcast**：`_meta` 有 exitCode/timedOut/usage，gates 有 verdict，loop 有 completed/budget_exhausted/failed——但没有统一的 step/run 级 stopReason 枚举，消费方（dashboard/resume/门）各自解读。

**借鉴**：统一 `stopReason` 枚举进 checkpoint 的 step 记录与 done() 摘要；resume-fix 和 dashboard 都消费同一个词。要点抄它的：**非 completed 一律不得被上层当成功**。

## 4. 配对事件 + observe-only 纪律

**dsh**：`workflow/start|end`、`agent-start|agent-end` 按 `seq` 严格配对；监听者拿到的是 `WorkflowRunInfo`（纯数据），**不是 live run**——观察者无法获得取消/处置权。事件不变量冷加载和实时追加双侧校验（重复 start、未配对 member、run-end 后更新都拒绝）。

**flowcast**：events.js 有中央注册表（好设计，保留），但三类事件来源分立、步骤事件不进 jsonl、无配对/seq 纪律。

**借鉴**：步骤事件升级为配对语义（start/done/skip/error 已有天然节点，加 seq 与不变量校验）；对外暴露的 run 句柄与观察数据分离（dashboard 消费数据投影，不消费 live 对象）。

## 5. 执行器能力协商（capabilities advertisement）

**dsh**：subagent provider 注册时声明 `capabilities`（outputSchema/depthLimit/toolFilter/persona），服务在 **start 之前**拒绝不支持的能力请求——fail before spawn。

**flowcast**：EXECUTORS 注册表只有 run 函数；能力差异靠文档约定（如 `permission: true` 依赖 CLI 支持，codebuddy 不支持——目前是 README 里提醒，不是注册表校验）。

**借鉴**：`registerExecutor(name, run, {capabilities})`——声明 `streaming` / `permission` / `sessionResume` / `structuredOutput` 等；`resolveAgent` 在 spawn 前校验请求能力 vs 声明能力，不匹配 fail-fast 带指引（"该 executor 不支持 permission，换 claude-code"）。我们已经在这类问题上踩过坑（hub PERMISSIONS.md 就是手工维护的这张表），把表变成注册表数据。

## 6. continuable agent + followup 权威链

**dsh**：`startContinuable` / `followup(parent, childId, ...)`——可续 agent 按 id 持有；追加消息的**权威**限定"精确的 live 直接父"（冷恢复时双重校验）；`reportFrom` 反向投递。durable header 记录 parent，防伪造 followup。

**flowcast**：多步 flow 中"同一个 agent 贯穿多步"目前是隐式的（agentproc adapter 的 sessionId passback，且仅 resume 型 CLI 受益）。

**借鉴**：显式原语 `agentSession(name, {cli, ...})`——按名字在 run 内持有一个 agent 会话，跨 step followup（step2 可向 step1 建立的 agent 追问），会话句柄与权威记录进 run log；冷恢复（进程重启后 resume flow）时经权威检查重建。这直接强化我们对比 dsh 的差异化长板（跨 step/跨重启的 agent 连续性）。

## 7. 文档纪律：Token / KV-Cache 记账

**dsh**：每个组件 README 都有 "Token effect" 与 "KV Cache effect" 段落（连"系统提示何时失效缓存"都写明）。

**flowcast**：组件文档讲行为不讲成本。

**借鉴**：agent/gates/loop/HITL 的文档各加成本记账段（每次调用的 token 量级、对上下文前缀的影响）。编排层的消费者正是在意成本的 agent 编排者。

## 优先级建议

| 借鉴项 | 价值 | 成本 | 建议 |
|---|---|---|---|
| 1 动态脚本面（runScript） | 高（补齐"即时编排"空档 + 对 dsh 的差异化） | 中 | 排期做 |
| 5 能力协商 | 高（消灭一整类配置错误） | 低 | 先做 |
| 3 stopReason 枚举 | 中高（resume/dash/门的地基） | 低 | 先做 |
| 2 总量预算 | 中 | 低 | 随 1 一起 |
| 6 agentSession | 高但可等需求 | 中 | 观察需求 |
| 4 配对事件 | 中 | 低 | 随 1 一起 |
| 7 文档记账 | 中 | 很低 | 随手做 |
