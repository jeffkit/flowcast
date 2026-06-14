# flowcast 排查失败参考

## 快速定位

```bash
# 列出最近 run
flowcast list
ls -lt .flowcast/runs/ | head -10

# 看 run 状态
cat .flowcast/runs/<id>/state.json | jq '{status, currentStep, pauseReason}'

# 看错误步骤
cat .flowcast/runs/<id>/run.log.jsonl | jq 'select(.status == "error")'
```

## 常见错误模式

### `[claude] exit 1`
claude CLI 在项目目录绑定了不可用的 model。
```bash
# 验证
claude -p "只回复ok" 2>&1
# 修复：在 .flowcast/config.json 固定 model
# "agents": { "default": { "model": "claude-sonnet-4-6" } }
```

### `Cannot find package 'flowcast'`
从 `node` 直接运行了 flow 文件，不是通过 `flowcast run`。
```bash
# 错误：node .flowcast/flows/xxx.js
# 正确：flowcast run .flowcast/flows/xxx.js --repo .
```

### `分支创建后仍处于 detached HEAD`
```bash
git checkout main
git branch -D feat/<feature>   # 删掉建了一半的分支
# 再续跑
```

### 质量门失败（clippy / test / build）
agent 写的代码有问题，先手动修，再续跑（checkpoint 会跳已完成步骤）。

### `相对起点 xxx 共 0 提交；判定为空成功`
agent 没有真正写代码。看 implement 步骤的输出：
```bash
cat .flowcast/runs/<id>/run.log.jsonl \
  | jq 'select(.key | test("implement")) | .result' | head -50
```

## 续跑 vs 重跑

```bash
# 续跑（推荐）：传同一个 run-id
flowcast force-dev --run-id <id> --repo .

# 重置某个步骤：从 state.json 删掉对应 key 再续跑
node -e "
const fs = require('fs'), p = '.flowcast/runs/<id>/state.json'
const s = JSON.parse(fs.readFileSync(p))
delete s.completed['p3.m1.implement']
fs.writeFileSync(p, JSON.stringify(s, null, 2))
"
flowcast force-dev --run-id <id> --repo .

# 全部重来：不传 run-id
flowcast force-dev --feature <same-name> --repo .
```
