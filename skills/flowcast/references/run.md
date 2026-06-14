# flowcast 运行任务参考

## 命令速查

```bash
# 标准开发闭环（分支 → 实现 → 审查 → PR）
flowcast force-dev --feature <name> --repo .

# 一句话需求自动生成并执行 flow
flowcast orchestrate "<需求描述>" --repo .

# 大目标拆子任务并发执行
flowcast orchestrate "<大目标>" --repo . --split --concurrency 3

# 跑已有 flow 文件
flowcast run .flowcast/flows/<name>.js --repo . [--参数 值]

# 续跑（传相同 run-id，已完成步骤自动跳过）
flowcast force-dev --run-id <id> --repo .
flowcast run .flowcast/flows/<name>.js --run-id <id> --repo .

# 列出历史 run
flowcast list

# 生成可观测看板
flowcast dashboard --repo . --open
```

## force-dev 完整参数

```bash
flowcast force-dev \
  --feature <feature-name>      # kebab-case，如 add-search-api
  --repo .                       # 项目路径
  [--run-id <id>]                # 续跑时传上次的 run-id
  [--model claude-sonnet-4-6]    # 覆盖 config 里的 model
  [--reviewer claude]            # 审查用哪个 CLI（默认 claude）
  [--prompt-file <path>]         # 批量模式：从文件读 feature 描述，跳过 HITL
```

## 处理 HITL 节点

flow 输出 `[paused]` 后：

```bash
# 1. 看暂停原因
cat .flowcast/runs/<id>/state.json | jq '{pauseReason, pauseContext}'

# 2. 按要求处理（如查看 docs/exec-plans/active/<feature>/prompt.md）

# 3. 续跑
flowcast force-dev --run-id <id> --repo .
```

## 查看 run 结果

```bash
cat .flowcast/runs/<run-id>/report.md          # 可读报告
cat .flowcast/runs/<run-id>/state.json | jq .  # 完整状态
tail -20 .flowcast/runs/<run-id>/run.log.jsonl | jq .  # 最近日志
gh pr list                                   # 查看生成的 PR
```
