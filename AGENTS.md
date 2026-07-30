# AGENTS.md — Flowcast

> 轻量 workflow 编排：断点续跑 · HITL · 多 Agent 调度 · 自改沙箱 · 质量门 + L3 codegen。
> 负责人：jeffkit | 创建：2026-06-11

## 项目概述

flowcast（本地目录曾叫 flowx）是最小依赖（仅 agentproc SDK）的纯 ESM 库 + CLI（`flowcast` / `flowx` / `fc`）。  
L1 驱动 CLI/Agent，L2 提供 Checkpoint / HITL / 质量门等原语，L3 `orchestrator/` 把多步编排需求生成并执行 flow。  
业务项目的 flow 放各自仓（如 `.flowcast/flows/`），本仓只放引擎与通用示例。

**技术栈：** Node.js ≥20, ESM, Workflow, HITL, AgentProc  
**主仓库：** `git@github.com:jeffkit/flowcast.git`

## 架构地图

```
L3 orchestrator/  → 生成/校验/执行 flow（续跑锁定）
L2 核心原语       → checkpoint / hitl / quality-gate / self-mod-guard / …
L1 executor.js    → 各 CLI adapter + provider 路由
```

关键目录：
- `index.js` — 公共 API 出口
- `executor.js` / `agent.js` — 执行器装配与兼容层
- `checkpoint.js` / `hitl.js` / `quality-gate.js` / `self-mod-guard.js` — L2 原语
- `orchestrator/` — L3（`orchestrate`、`generate`、`validate`）
- `dashboard/` — 只读可观测看板
- `bin/flowcast.js` — CLI
- `examples/` / `skills/flowcast/` — 示例与 Claude Skill
- `docs/BACKGROUND.md` — 愿景与边界（新 session 先读）

## 开发约定

**分支策略：** `main`；PR 合并。

**禁止事项：**
- 禁止把 API Key / provider 明文写进仓（用 `~/.flowcast/*.json` + `${ENV}`）
- 禁止在本仓堆业务项目专用 flow（放业务仓，`file:` 依赖本包）
- 禁止绕过质量门 / 自改沙箱做「方便的」自改
- 禁止随意引入运行时 npm 依赖（设计约束：最小依赖，当前仅 agentproc SDK）

## 常用命令

```bash
npm test                                      # node --test test/
npm install -g .                              # 本地装 CLI（可选）
flowcast orchestrate "<目标>" --repo .
flowcast orchestrate "<大目标>" --split
flowcast dashboard --repo . --open
flowcast run ./flows/my-flow.js
```

## 当前状态

**当前里程碑：** {待人工填写}

## 深入阅读

| 文档 | 说明 |
|------|------|
| `README.md` | 安装与快速上手 |
| `docs/BACKGROUND.md` | 背景与路线图 |
| `CLAUDE.md` | 模块地图与配置分层 |
| `orchestrator/FLOW_API.md` | L3 契约 |
| https://jeffkit.github.io/flowcast/ | 站点文档 |
