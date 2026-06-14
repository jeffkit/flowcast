# flowcast 可用性 Gap 评审报告

> 评审人视角：资深架构师
> 评审日期：2026-06-14
> 评审对象：flowcast `main`（commit `9911a80`，version `0.1.0`）
> 核心问题：**距离「真正可用」（对外可被陌生用户安装、按文档跑通、产出可信赖）还差什么？**

---

## 0. 评审方法

- 通读三层架构全部核心模块（L1 `agent.js`/`executor.js`、L2 `checkpoint.js`/`self-mod-guard.js`/`quality-gate.js`/`loop.js`/`subflow.js`、L3 `orchestrator/`）。
- 运行全量单测：`npm test` → **226 通过 / 0 失败**。
- 核对文档（`README.md`、`CLAUDE.md`、`BACKGROUND.md`、`EVALUATION.md`、`exec-plans/active/*/status.md`）与代码实现的一致性。
- 检查工程化基础设施（CI、lint、format、发布链路）与文件完整性。

---

## 1. 总体结论

flowcast 的**内核设计是扎实的**：原语正交、零运行时依赖、纯 ESM、经历了 8 轮安全审计修复，226 个单测全绿。L1/L2 已达到「能作为库被消费」的成熟度（recursive 仓的 `file:` 依赖消费已验证）。

但**距离「对外真正可用」仍有明确缺口**，集中在三类：

| 类别 | 一句话 |
|------|--------|
| **数据正确性 / 文件完整性** | 有 1 个文件被损坏成二进制、1 处品牌迁移残留导致默认路径写错位置 |
| **真实可靠性证据缺失** | L3 codegen 端到端、断点续跑成功率等关键指标**从未用真实负载验证过**，全靠 fake executor 单测 |
| **工程化 / 上手体验** | 无 push/PR CI、无 lint；README「30 秒上手」对陌生用户不成立（依赖未内置的 force-dev、未发布的 npm 包、未配置的 provider） |

**成熟度判断**：内核 ~85% 可用；作为「对外开箱即用的产品」~55%。下面按严重程度分级列出。

---

## 2. Gap 清单（按严重程度）

### 🔴 P0-1：`checkpoint.js` 含字面量 NUL 字节，文件被损坏为二进制　✅ 已修复（2026-06-14）

> **修复**：第 18 行 sentinel 改为转义序列 `'\x00flowcast:sidecar\x00'`，运行时字符串不变（旧 state.json sidecar 仍兼容）。`file checkpoint.js` 现报 `UTF-8 text`，全文 NUL 字节归零，`node --check` 通过，226 单测全绿。

**证据**：
- `file checkpoint.js` → `data`（而非 ASCII/UTF-8 text）。
- offset 632 附近存在两个**字面量 `\0`（NUL）字节**：源码本意是
  `const RESULT_SIDECAR_MARKER = '\x00flowcast:sidecar\x00'`，但实际写入的是**真实 NUL 字节**而非转义序列。
  hexdump 证实：`27 00 66 6c 6f 77 63 61 73 74 ... 00 27`（`'<NUL>flowcast:sidecar<NUL>'`）。

**影响**：
- 整个 `.js` 文件被 git / 编辑器 / `grep` / 标准 Read 工具识别为**二进制**——diff 不可读、代码审查看不了、IDE 跳转/高亮失效。
- 这是 checkpoint（断点续跑核心模块）所在文件，未来任何改动都难以 review。
- `node` 当前能跑只是侥幸（NUL 在字符串字面量内是合法字符），属于**脆弱的隐性正确性**。
- 该文件会随 `npm publish` 进入发布包（`package.json` files 列表已包含它），下游拿到的也是二进制文件。

**建议**：把字面量 NUL 改成转义序列 `'\x00flowcast:sidecar\x00'`（或改用不含控制字符的 sentinel，如 `'\uE000flowcast:sidecar'` 私有区字符）。修复后 `file` 应报 text，并补一个单测断言「源文件不含 NUL / sentinel 行为正确」。

---

### 🔴 P0-2：品牌迁移 flowx→flowcast 不彻底（默认路径错位 + 升级丢续跑）　✅ 已修复（2026-06-14）

**初判**：`Checkpoint` 构造函数默认 `stateDir` 写死 `.flowx/runs`。

**深查后发现问题更根本**（评审复盘时由「升级是否丢已有 run」的追问引出）：
1. `dirs.js` 的 `flowcastDir()` 原规则是「`.flowcast/` 目录存在才用它，否则一律回退 `.flowx/`」。而源码**没有任何地方会主动创建 repo 级 `.flowcast/`** → 结论：**全新项目第一次跑 flow，数据其实落到 `.flowx/runs/`**，与 README「新项目使用 `.flowcast/`」及品牌重命名直接矛盾（且旧测试还固化了「初始应选 `.flowx`」）。
2. **升级丢续跑**：老项目 `.flowx/runs/` 里有进行中（paused）的 run，用户一旦按新 README 建 `.flowcast/config.json`，`flowcastDir` 立刻翻转到 `.flowcast/`，原 `run-id` 续跑去 `.flowcast/runs/` 找不到 → 当成全新 run 从头跑，旧进度变孤儿。

**修复**（集中在单一事实来源 `dirs.js` 的 `resolveBaseDir`，不做破坏性数据搬迁）：
- 全新项目（两目录皆无）→ 默认 `.flowcast/`（修掉「新数据落 .flowx」）。
- 仅有旧 `.flowx/` 的项目 → 继续 `.flowx/`（续跑连续性）。
- 两者并存但 `.flowcast/` 尚无 `runs/` 而 `.flowx/runs` 有数据 → **黏住 `.flowx/`**（防升级切断续跑）；待 `.flowcast/runs` 也有数据后再切。
- `Checkpoint` 默认 `stateDir` 一并改为 `flowcastDir(process.cwd()) + '/runs'`，与 `loop.js`/flow 骨架统一。
- 同步修正 `dirs.js` 头注释与 `dashboard/index.js` 过时 JSDoc。新增 2 个针对性单测（全新项目默认 / 升级黏住）。**228 单测全绿**。

> 注：本项**未提供** `.flowx → .flowcast` 的数据合并/迁移命令。当前策略是「读时按数据所在目录解析、不强制搬迁」；若希望把历史 `.flowx/` 数据统一并入 `.flowcast/`，可另开一个显式 `flowcast migrate`（待决策）。

**证据**：
- `checkpoint.js` 构造函数签名：`constructor(runId, stateDir = '.flowx/runs', ...)`。
- 全仓仍有 30+ 文件出现 `flowx`/`.flowx`/`FLOWX_*`（`grep` 计数）。其中**环境变量向后兼容是合理的**，但**默认值错位是 bug**。

**影响**：
- 用户若 `new Checkpoint(id)` 不显式传 `stateDir`，run 数据会落到 `.flowx/runs/` 而非 `.flowcast/runs/`，而 `dashboard`/`list`/README 全部指向 `.flowcast/`——**默认配置下看板看不到自己的 run**。
- README 示例显式传了 `.flowcast/runs`，掩盖了这个默认值问题，属于「文档对、默认错」的陷阱。

**建议**：默认值改为 `.flowcast/runs`；保留对已存在 `.flowx/runs` 的向后兼容读取（与 `dirs.js`/`bin` 已有的兼容逻辑对齐，做到单一事实来源）。

---

### 🟠 P1-1：L3 codegen 端到端**从未用真实负载验证可靠性**

**证据**：
- `exec-plans/active/l3-codegen-harness/status.md` §后续：「用真实 agent 跑一次真生成（非 fake），观测生成质量」列为**未做**。
- `BACKGROUND.md` 路线图明确：「下一步是把 `--split` 多任务也拿真实 agent 跑通（验证 LLM 分拆质量 + fanOut 隔离并发稳定性）」——即 `--split` 真实链路**尚未跑通**。
- `generateFlow` 的重试上限 `maxAttempts = 2`（2 次校验失败即返回失败），但**真实 LLM 一次生成合法 flow 的成功率没有任何 baseline 数据**。
- 全部 orchestrator 单测都注入 `generate`/`decomposeGen` 假函数，绕过真实 LLM。

**影响**：
- L3（codegen 编排）是 flowcast 区别于普通 runner 的**核心卖点**，但它最不确定的环节（LLM 能否在词汇表约束下稳定生成可校验、可跑通的 flow）**零实测**。
- `--split` 作为 README/CLI 明确宣传的能力（`flowcast orchestrate "大目标" --split`），真实端到端未验证，存在「宣传了但跑不通」风险。

**建议**：把「真实 agent 生成成功率」「`--split` 真实并发稳定性」纳入冒烟基线，至少各跑 5~10 次留痕；据此决定是否调高 `maxAttempts`、补 few-shot。

---

### 🟠 P1-2：断点续跑 / HITL 等**核心承诺无真实运行数据**，`EVALUATION.md` 形同空壳且严重过时

**证据**：
- `EVALUATION.md` §三「运行记录」表 = **一行占位「待首次运行」**，即真实案例运行次数 = 0。
- 所有目标值（断点恢复成功率 ≥95%、非预期中断率 ≤5% 等）**无任何实测支撑**。
- `EVALUATION.md` 通篇仍是旧叙事：`flowx`、`.flowx/runs/`、`/feature-dev`、「skill 版 force-dev 对比」——与当前 L3 codegen 定位**脱节**，标题甚至还是「flowx 效果评估方案」。

**影响**：
- 「断点续跑、HITL」是 README 头号卖点，但**可靠性是被单测覆盖的，不是被真实运行证明的**。对「真正可用」而言，缺少跑过真实任务的证据链。
- 评估文档过时会误导后续维护者，且无法支撑「是否全面推广」的决策节点。

**建议**：要么真正启动评估（积累 5~10 次真实 run 填表），要么把 `EVALUATION.md` 重写/降级为「评估框架待启动」，并统一术语到 flowcast。

---

### 🟠 P1-3：无 push/PR CI、无 lint/format —— P0-1 的 NUL 字节正是因此溜进来

**证据**：
- `.github/workflows/` 仅 `docs.yml` + `publish.yml`；`publish.yml` 只在**打 tag 发布时**跑 `npm test`。**普通 push/PR 没有任何自动测试或检查门**。
- 无 `.eslintrc*` / `eslint.config.*` / `.prettierrc*`（lint/format 配置缺失），但代码里已出现 `eslint-disable`（`orchestrator/run.js`）——说明**预期有 lint 却没配**。

**影响**：
- 缺少 push/PR 上的 test gate，回归只能靠人手 `npm test`。
- 缺少 lint，像「字面量 NUL 字节」「未使用变量」「文件编码异常」这类问题没有自动拦截——P0-1 就是直接后果。
- 对一个准备 `npm publish` 对外的库，CI 门禁是「可用」的基本盘。

**建议**：加 `ci.yml`（push/PR 触发 `npm test` + `node --check`，建议加文件编码/NUL 检查）；引入 eslint（哪怕最小规则集）并在 CI 跑。

---

### 🟠 P1-4：README「30 秒上手」对陌生用户不成立

**证据 & 影响**：
1. **`npm install -g flowcast` 可能不可用**：version `0.1.0`，README 顶部 npm badge 指向 `npmjs.com/package/flowcast`。若尚未发布，badge 404、安装命令失败。（`publish.yml` 注释提到 `@force-lab` scope token，与无 scope 的包名 `flowcast` 也存在不一致风险。）
2. **`flowcast force-dev` / `flowcast list` 依赖未内置的 flow**：仓内**无 `flows/` 目录**，`force-dev` flow 不在包里。但 README/CLI 帮助大量以它为例，且 `flowcast list` 实现是「找不到 force-dev 就报错退出」（`bin/flowcast.js`）。陌生用户照着 README 跑 `flowcast list` 会直接失败。
3. **`flowcast orchestrate "..."` 真跑需要先配置 provider/agent**：README「30 秒」示例没提这一步，真实跑通门槛被低估（需 `~/.flowcast/providers.json` + agent profile + 对应 CLI 已登录）。

**建议**：
- 确认 npm 发布状态，未发布则修正 badge/安装说明或先发布。
- 要么把一个最小可用 flow（或 force-dev）内置进包，要么把 README 示例改成「自带的、无需额外安装」的命令；`flowcast list` 不应硬依赖 force-dev。
- README 增加「真跑前置：配置 provider」最小段落。

---

### 🟡 P2-1：revengers L3 编排理念集成 —— 未开始（已知路线图项）

`BACKGROUND.md` 路线图项 2（接单/分拆/调度/Arbiter 的选择性集成）尚未启动。这不影响当前定位下的「可用」，但是愿景闭环的一块。属于规划内，**非缺陷**，列出以求完整。

### 🟡 P2-2：可观测/文档站链接需校验

README 指向 `https://jeffkit.github.io/flowcast/`（docs-site 存在）。发布前需确认文档站已部署且与 `main` 同步（避免文档/代码版本漂移）。

---

## 3. 建议的修复优先级

| 优先级 | 项 | 工作量 | 理由 |
|--------|----|--------|------|
| ~~P0~~ ✅ | 修 `checkpoint.js` NUL 字节（已完成 2026-06-14） | 极小 | 文件完整性，影响所有后续维护，且进发布包 |
| ~~P0~~ ✅ | `Checkpoint` 默认 `stateDir` 改 `flowcastDir()+/runs`（已完成 2026-06-14） | 小 | 默认配置下数据写错位置 |
| **P1** | 加 push/PR CI（test + node --check + NUL/编码检查）+ 最小 eslint | 小 | 守住可用基本盘，防 P0 类问题复发 |
| **P1** | L3 真实负载冒烟（单任务 + `--split`），建立成功率 baseline | 中 | 核心卖点的可靠性证据 |
| **P1** | 修 README 上手路径（npm 发布状态 / 内置最小 flow / provider 前置说明） | 小~中 | 陌生用户能否跑通的决定因素 |
| **P1** | 重写或降级 `EVALUATION.md`（术语统一 + 明确「待启动」或真启动） | 小 | 消除误导，对齐现状 |
| **P2** | revengers 编排理念集成、文档站校验 | 中 | 愿景闭环 / 发布前检查 |

---

## 4. 附：做得好的地方（避免只看缺点）

- **原语设计正交、职责清晰**：checkpoint / self-mod-guard / quality-gate / loop / subflow 各自可独立测试，flow 只做薄编排，符合「原语优先」约定。
- **安全防护到位**：mcp2cli 路径白名单 + RCE 防护、prompt 注入用代码块隔离、import 白名单、最小化 dry-run env（不泄露密钥给未验证的生成 flow）、续跑锁的僵尸/PID 检测。
- **失败语义考究**：自改沙箱回滚失败用 `Error cause` 链式抛、provider/CLI 双层回退 + 指数退避冷却、超时 SIGTERM→SIGKILL 兜底防孤儿进程。
- **零运行时依赖、纯 ESM、Node≥20**，226 单测覆盖含结构化 E2E（fake executor，不烧 API）。
- **配置分层干净**：通用库 / 项目仓 `.flowcast/` / 机器级 `~/.flowcast/` 三分，密钥 `${VAR}` 运行时插值不入仓。

---

> 一句话总结：**内核已经能当库用且经得起审计；文件完整性的 2 个 P0 已修复（2026-06-14），剩下要补的是真实负载的可靠性证据，以及 CI/上手路径这条工程化基本盘。**
