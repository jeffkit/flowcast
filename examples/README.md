# flowcast examples — pge flow 与跨语言配置

## pge（Planner-Generator-Evaluator）

`pge.flow.js` 是参考 [Anthropic harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)
的内置 flow：一句话需求 → Planner 拆 sprint → Generator 实现 → Evaluator 验收 → repair loop。

与社区流行的 PEV（Plan-Execute-Validate）同构，无需纠结叫法。

```bash
flowcast run pge --goal "给登录页加 remember me 复选框" --repo .
flowcast run pge --goal "..." --dry-run          # 结构冒烟，不烧 API
flowcast run pge --goal "..." --agent claude      # 指定 CLI profile
```

## 跨语言适配：三件套配置

pge 的骨架是语言无关的（三角色 + sprint contract + repair loop），各技术栈的差异
全部通过 `<repo>/.flowcast/` 下的三个配置文件表达，**flow 代码不写死任何构建工具**：

| 文件 | 作用 | 无此文件时的行为 |
|------|------|-----------------|
| `gates.json` | 质量门（构建/测试/lint 命令 + onFail 策略） | 不跑门（`loadGates` 返回 `[]`） |
| `agents.json` | planner/generator/evaluator 用哪个 CLI profile | 回退到用户级 `~/.flowcast/agents.json` |
| `hygiene.md` | 该仓卫生铁律，注入 Generator 的 build/repair prompt | 退化为语言无关通用铁律（`GENERIC_HYGIENE`） |

### 各技术栈样板

- **Rust**（ilink-hub）：`gates.json` = fmt/clippy/test/build；`hygiene.md` = mod.rs 注册、
  Cargo.lock 提交、禁止裸 unwrap。见 `ilink-hub/.flowcast/`。
- **TypeScript**（lavs）：`gates.json` = pnpm build/vitest；`hygiene.md` = 双端一致、
  changesets。见 `lavs/.flowcast/`。
- **Python**（hil-mcp）：`gates.json` = pytest/tsc；`hygiene.md` = Alembic 迁移、
  GitNexus 铁律。见 `hil-mcp/.flowcast/`。

### 为新仓配置 pge

1. 在仓根建 `.flowcast/` 目录
2. 写 `gates.json`（参考同技术栈的试点仓或 `agents.example.json` 的格式）
3. 写 `agents.json`（声明用哪个 CLI：claude/codex/gagy…）
4. 写 `hygiene.md`（该仓的硬约束：模块注册约定、依赖管理、代码规范）
5. 验证：`node <flowcast>/examples/pge.flow.js --dry-run --repo . --goal "test"`

## 其他样例

- `golden-sample.flow.js`（在 `orchestrator/examples/`）— 并行多 agent 分析 → 质量门 → 收口
- `agents.example.json` / `providers.example.json` — 配置文件格式样板
