# flowcast 项目配置参考

## .flowcast/config.json 各语言模板

### Rust

```json
{
  "qualityGates": [
    { "name": "fmt",    "cmd": "cargo fmt --check",       "onFail": "autofix",     "autofixCmd": "cargo fmt" },
    { "name": "clippy", "cmd": "cargo clippy -- -D warnings", "onFail": "resume-fix" },
    { "name": "test",   "cmd": "cargo test",              "onFail": "resume-fix" },
    { "name": "build",  "cmd": "cargo build",             "onFail": "rollback" }
  ],
  "agents": {
    "default":  { "cli": "claude", "model": "claude-sonnet-4-6" },
    "reviewer": { "cli": "claude", "model": "claude-sonnet-4-6",
                  "extraPromptPrefix": "你是 Rust 安全与并发专家，重点审查内存安全、data race、tokio 异步陷阱、OWASP 安全问题。" }
  }
}
```

### Node.js / TypeScript

```json
{
  "qualityGates": [
    { "name": "lint",  "cmd": "npm run lint",      "onFail": "autofix", "autofixCmd": "npm run lint -- --fix" },
    { "name": "tsc",   "cmd": "npm run typecheck", "onFail": "resume-fix" },
    { "name": "test",  "cmd": "npm test",          "onFail": "resume-fix" },
    { "name": "build", "cmd": "npm run build",     "onFail": "rollback" }
  ],
  "agents": {
    "default":  { "cli": "claude", "model": "claude-sonnet-4-6" }
  }
}
```

### Python

```json
{
  "qualityGates": [
    { "name": "fmt",  "cmd": "ruff format --check .", "onFail": "autofix", "autofixCmd": "ruff format ." },
    { "name": "lint", "cmd": "ruff check .",          "onFail": "resume-fix" },
    { "name": "test", "cmd": "pytest",                "onFail": "resume-fix" }
  ],
  "agents": {
    "default": { "cli": "claude", "model": "claude-sonnet-4-6" }
  }
}
```

### Go

```json
{
  "qualityGates": [
    { "name": "fmt",   "cmd": "test -z \"$(gofmt -l .)\"", "onFail": "autofix", "autofixCmd": "gofmt -w ." },
    { "name": "vet",   "cmd": "go vet ./...",               "onFail": "resume-fix" },
    { "name": "test",  "cmd": "go test ./...",              "onFail": "resume-fix" },
    { "name": "build", "cmd": "go build ./...",             "onFail": "rollback" }
  ],
  "agents": {
    "default": { "cli": "claude", "model": "claude-sonnet-4-6" }
  }
}
```

## onFail 策略说明

| 值 | 行为 |
|----|------|
| `rollback` | 硬回滚到上一个 git commit，flow 终止 |
| `resume-fix` | 失败输出喂给 agent 自动修，修完重测；仍失败则抛错 |
| `autofix` | 跑 `autofixCmd` 自动修，不重测，直接过（适合 fmt） |

建议：`build` 用 `rollback`，`fmt` 用 `autofix`，`test`/`lint` 用 `resume-fix`。

## agent 回退链（多 provider）

主 agent 限额时自动切备用：

```json
"agents": {
  "default": [
    { "cli": "claude", "model": "claude-sonnet-4-6" },
    { "cli": "gemini" }
  ]
}
```

## .gitignore 必加

```
.flowcast/runs/
.flowcast/memory/
.flowcast/prompt-*.md
```
