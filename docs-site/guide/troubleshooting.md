# 排错 / FAQ

flowcast 的设计偏好 **fail-fast**：配置/环境不对时立刻报错并给出修法，而不是静默卡死。本页是常见报错对照表。

## 常见报错 → 含义 → 怎么修

### `目标仓无法解析 flowcast`

**含义**：`orchestrate` 预检（`checkFlowcastResolvable`）发现目标仓 `node_modules` 解析不到本包，而生成的 flow 会 `import` 它。

**修法**：在目标仓安装本包。

```bash
cd <目标仓> && npm install flowcast
# 或源码：npm install ~/projects/flowcast
```

### `未知 provider 'x'` / `未知 agent 'x'`

**含义**：`~/.flowcast/providers.json` 或 `agents.json`（含项目级 `<repo>/.flowcast/` 覆盖）里没有这个名字。

**修法**：补上对应配置，或改用已定义的名字。报错信息会列出"已定义"的名字。参见 [配置分层](/guide/configuration)。

### `执行器 'cursor' 不接受外部 provider（自管鉴权/路由）`

**含义**：给锁定型执行器（cursor / gemini / codex / agy）配了 `provider`。它们自管鉴权，不接受外部 provider。

**修法**：从该 agent profile 去掉 `provider` 字段，改用它自带的 `model` 选择。BYO-LLM（recursive / aider / claude）才能注入 provider。

### `环境变量 X 未设置（插值 ${X} 失败）`

**含义**：provider 配置里用了 `${X}`，但运行时进程 env 没有 `X`。flowcast 区分"显式空串"（合法）与"未定义"（报错）。

**修法**：`export X=...` 后重跑。密钥永远只在 env，不写进配置文件。

### 生成的 flow 校验失败（import 白名单 / 语法 / dry-run）

**含义**：L3 生成的 flow 违反契约——`import` 了非 `flowcast`（+`util`）的模块、语法错误，或 dry-run 冒烟跑不通。`validateFlow` 拦截。

**修法**：
- 查看 `.flowcast/runs/<run-id>/` 下的生成产物定位问题。
- 重试生成（`orchestrate` 有限次重试），或换一个能力更强的 `--agent`。
- 手写 flow 时：只 `import flowcast`（+`util`），只用 [FLOW_API](/api/) 词汇表的原语，需要文件/git 走 flowcast 原语（别裸调 `child_process`）。

### agent CLI 未安装 / 未登录 / 限额

**含义**：L1 执行器对应的 CLI（claude / cursor / …）不可用。

**修法**：安装并登录对应 CLI；对限额/超时，用 `runAgentChain` 配多个 agent 做跨 CLI 回退（自带自适应冷却退避）。

### `withSelfModGuard: 工作树不干净，请先 commit/stash`

**含义**：自改沙箱要求跑前有干净的 git baseline（以便失败时硬回滚）。

**修法**：先 `git commit` 或 `git stash`；或显式传 `requireClean: false`（不推荐，会失去干净回滚点）。

### 跑到一半中断了 / 进程被杀

**含义**：正常——Checkpoint 就是为此设计的。

**修法**：用**同一个 `--run-id`** 再跑一次，已完成的 step 会 `[skip]`，从断点继续。

## FAQ

### dry-run 通过了，就代表能真跑成功吗？

不。dry-run 只验证**结构 / 骨架 / 配置**（执行器与质量门被 fake，不烧 API、不跑构建）。它**不**验证真实 LLM 产出质量与真实构建结果。上线前务必跑一次真的。

### `orchestrate`、`orchestrate --split`、手写 flow、`force-dev` 我该用哪个？

- 一行需求、单目标 → `orchestrate`
- 大目标可拆成多个独立子任务 → `orchestrate --split`
- 流程固定、要精细控制（条件分支/重试/特定 HITL 点）→ 手写 flow，`flowcast run ./my-flow.js`
- 标准开发流（建分支→写码→审查→PR）→ `flowcast run force-dev`（需先 `flowcast flows install`）

详见 [L3 编排](/guide/orchestration) 与 [给 AI 使用](/guide/for-ai) 的决策树。

### 我能不配 provider 吗？

可以——如果只用锁定型执行器（如 `cursor-default`，本机已登录 cursor-agent）。它们自管鉴权，不需要 `~/.flowcast/providers.json`。

### 状态和日志在哪？

`.flowcast/runs/<run-id>/`：`state.json`（状态/完成步骤/暂停原因）、`run.log.jsonl`（逐行审计：每步耗时/输入输出/错误/event）、`report.md`（done 后摘要）。失败时先看 `run.log.jsonl` 末尾的 error 行。

### flowcast 会不会帮我管运行时（daemon/状态机/锁）？

不会。flowcast 是**进程定义/编排层**，不是运行时治理框架。它不存业务状态、无常驻服务、不做 DAG。运行时治理归上层系统。
