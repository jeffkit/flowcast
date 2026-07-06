# flowcast vs N8N vs LangGraph 对比

> 最后更新：2026-06-22

---

## 一、三者定位

| 维度 | N8N | LangGraph | flowcast |
|------|-----|-----------|---------|
| **核心抽象** | 可视化节点 DAG | 状态机 / 有向图 | 命令式代码 + codegen |
| **执行单元** | SaaS API / Webhook 节点 | LLM chain / Python 函数 | CLI 进程 / coding agent |
| **目标用户** | 业务自动化人员 | AI 应用开发者 | coding agent 编排工程师 |
| **依赖生态** | 浏览器 + 服务端 + 数百集成 | Python + LangChain 全家桶 | 零运行时依赖，纯 ESM Node |

---

## 二、相似之处

### 与 N8N 的共同点

- 都解决「多步骤工作流的编排与状态管理」
- 都支持 HITL（人工介入节点）
- 都有某种形式的断点恢复（N8N 有执行历史，flowcast 有 `Checkpoint`）

### 与 LangGraph 的共同点

- 都专为 AI / agent 场景设计
- 都有持久化状态 + 可续跑
- 都支持循环（LangGraph 的 cycle，flowcast 的 `loop` 原语）
- 都是开发者向的代码优先框架
- 都在思考多 agent 协同

---

## 三、关键差异

### 3.1 对 DAG 的态度——最根本的分歧

N8N 和 LangGraph 都以「图 / DAG」为核心抽象，把工作流表达成节点和边。

flowcast **刻意拒绝 DAG**：

> flow 逻辑是命令式的（条件 resume、budget 重试、verdict 分支），DAG 反而要为这些控制流再造一套表达，得不偿失；codegen 出来的就是能被人读、能被 dry-run 校验的真实 flow。

flowcast 的 L3 编排不生成图，而是**生成真实可读的 JS flow 代码**——代码即数据，跟人手写的 flow 同构。

### 3.2 执行单元的本质不同

- **N8N**：节点 = 调用某个 SaaS 的 REST API（Slack、Gmail、Postgres……）
- **LangGraph**：节点 = 调用 LLM 或 Python 函数，边 = 路由条件
- **flowcast**：执行单元 = 一个 **CLI 进程**（`claude`、`cursor`、`gemini`、`codex`、`recursive` 二进制……），通过 `adapters.js` 统一驱动

这决定了 flowcast 更关心**进程级隔离、stdout/stderr 捕获、超时/重试、provider 路由**，而不是数据流 schema 或 LLM message 格式。

### 3.3 质量门与自改安全沙箱——flowcast 独有

| 能力 | N8N | LangGraph | flowcast |
|------|-----|-----------|---------|
| 步骤后硬质量门 | ❌ | ❌ | ✅ `runGate`（失败触发 rollback / autofix） |
| 自改安全沙箱 | ❌ | ❌ | ✅ `self-mod-guard.js`（捕获 baseline → 失败即硬回滚） |
| 质量门声明式配置 | ❌ | ❌ | ✅ `.flowcast/gates.json`，与内置默认门合并 |

N8N / LangGraph 更关心「跑通」，flowcast 更关心「跑对 + 跑坏了能回滚」。

### 3.4 三层架构 vs 扁平图

N8N 和 LangGraph 本质是**单层**：图定义 + 图执行。

flowcast 是**三层分离**：

```
L3 接单/分拆 → 动态生成 flow 代码
L2 执行引擎  → 断点续跑 / 质量门 / HITL / dry-run
L1 执行器    → 可互换的 CLI worker
```

这三层可以独立组合，不必全用。比如只用 L2 的 `Checkpoint + parallel`，不用 L3 的 codegen。

### 3.5 生态与重量

| | N8N | LangGraph | flowcast |
|--|-----|-----------|---------|
| 运行时依赖 | 大量（数据库、UI 服务等） | Python + LangChain 生态 | **零** |
| 交互方式 | 浏览器可视化 | Python SDK | 命令行 + JS API |
| 适合场景 | 企业集成自动化 | LLM 应用开发 | coding agent 自改 / 编排 |

---

## 四、Checkpoint 机制专项对比

### 4.1 LangGraph Checkpoint

LangGraph 的 checkpoint 是**图状态快照**系统。

```python
from langgraph.checkpoint.sqlite import SqliteSaver

memory = SqliteSaver.from_conn_string(":memory:")
graph = builder.compile(checkpointer=memory)

config = {"configurable": {"thread_id": "my-run-1"}}
graph.invoke({"messages": [...]}, config)  # 第一次跑
graph.invoke(None, config)                 # 续跑，从上次暂停点继续
```

| 维度 | LangGraph | flowcast |
|------|-----------|---------|
| **存什么** | **整个 graph state**（所有节点共享的状态字典） | **每个 step 的返回值**（key → result） |
| **存储后端** | 可插拔：MemorySaver / SqliteSaver / PostgresSaver | 文件系统（`.flowcast/runs/<runId>/state.json`） |
| **续跑粒度** | 节点级（图中每个节点执行后都存一次） | 步骤级（`cp.step(key, fn)` 执行后存一次） |
| **时间旅行** | ✅ 内置：可回到任意历史 checkpoint，fork 出新分支 | ❌ 没有，只有"跑到哪存到哪" |
| **HITL 暂停** | `interrupt_before`/`interrupt_after` 声明式注入 | `cp.pause(reason)` 命令式调用，抛 `PauseSignal` |
| **状态 Schema** | TypedDict 强类型（编译期校验） | 无 schema，纯 JSON 键值 |
| **大结果处理** | 存进 state dict（用户自己管大小） | 自动 sidecar 旁路文件（>500 字节独立存储） |
| **原子写安全** | 依赖后端事务（SQLite / Postgres 的 ACID） | write-rename（POSIX atomic，无外部依赖） |
| **审计日志** | 没有单独的 log，state 就是日志 | `run.log.jsonl` 独立审计轨迹 |
| **质量门** | ❌ 无内置 | ✅ `runGate` 每步后可硬验证 + 回滚 |

**最大的设计分歧：**

LangGraph 存的是「图的当前状态」——所有节点共享同一个 state dict，续跑本质是从某个状态快照重放图。

flowcast 存的是「每个步骤的输出结果」——步骤之间不共享状态，每个 `cp.step` 只关心自己的 key→result，flow 代码本身控制数据流向。

```
LangGraph：  state_t0 → node_A → state_t1 → node_B → state_t2
                         ↑ 每次存完整快照，可任意回溯

flowcast：  cp.step('step-a', fn) → 存 completed['step-a'] = result
            cp.step('step-b', fn) → 存 completed['step-b'] = result
                                      ↑ 存的是结果，不是全局状态
```

### 4.2 N8N Checkpoint（几乎没有）

N8N **没有真正意义上的 checkpoint**，只有「执行历史记录」，两者目的不同：

| | N8N 执行历史 | flowcast Checkpoint |
|-|-------------|---------------------|
| **主要用途** | 审计 / 事后调试 | **断点续跑（核心功能）** |
| **续跑能力** | ❌ 只能从头重跑整个 workflow | ✅ 从上次成功步骤继续 |
| **HITL 暂停** | Wait 节点（webhook 等外部信号触发继续） | `cp.pause()` → `PauseSignal` |
| **存储** | SQLite / PostgreSQL（平台级，不跟 flow 走） | 文件系统（跟 runId 走，可迁移） |
| **跨机器迁移** | ❌ 不支持 | ✅ 复制 `.flowcast/runs/<runId>/` 目录即可续跑 |
| **失败后行为** | 标记 execution 为 failed，手动重试从头跑 | 从失败步骤之前的最后一个完成步骤续跑 |

N8N 的 HITL 通过 **Wait 节点**实现（节点阻塞，等 webhook 回调），与 checkpoint 无关——节点状态由 N8N 平台维护，不是用户可控的持久化文件。

### 4.3 flowcast Checkpoint 核心机制

flowcast checkpoint 最接近的类比是**构建系统里的 build cache**（Make / Bazel 的增量构建思想）：已经跑过的步骤结果持久化，下次跳过，只补跑失败 / 未完成的部分。

**目录结构：**

```
.flowcast/runs/<runId>/
  state.json           ← 核心状态（completed map + steps 摘要）
  run.log.jsonl        ← 结构化审计日志（每行一个事件）
  report.md            ← 完成时生成的可读报告
  steps/
    step_a_3a5f1c.out  ← 大结果旁路文件（首行类型标记 + 实际内容）
```

**关键设计决策：**

| 问题 | 解法 |
|------|------|
| 进程被 SIGKILL 怎么办 | write-rename 原子写（POSIX atomic rename） |
| 大结果（如 agent stdout）怎么存 | sidecar `.out` 文件，state.json 只存占位 marker |
| 循环里 key 重复怎么检测 | `_seenKeys: Set`，warn 提示加下标 |
| 并发 step 相同 key 怎么防 | `_inFlight: Set`，立即抛 `STEP_REENTRY` |
| 旁路文件丢失（跨机器迁移）怎么处理 | `_loadResult` 检测缺失后清除 completed[key]，步骤重新执行 |

---

## 五、一句话总结

**N8N** 是面向业务集成的「可视化 ETL + API 胶水」；**LangGraph** 是面向 LLM 应用的「状态机驱动的 AI agent 框架」；**flowcast** 是面向 coding agent 编排的「命令式 flow 引擎 + codegen 自改沙箱」——它不要图，不要 UI，只要能把 CLI 进程跑对、跑安全、跑完了能续跑，并且 L3 能动态生成整条 flow 代码来驱动 coding agent 完成任意目标。
