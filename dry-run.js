// dry-run.js — flowcast dry-run 模式开关
//
// dry-run 让任意 flow 零成本跑通骨架：执行器（LLM 调用）与质量门（构建）被 fake 成成功，
// git / checkpoint 仍真跑（通常在一次性 temp repo 里）。用途：
//   - L3 codegen harness 的「跑前校验」护栏（validateFlow 用假执行器跑生成的 flow）。
//   - 任何 flow 的结构冒烟（不烧 API、不等构建）。
//
// 开关：环境变量 FLOWCAST_DRY_RUN（'1'/'true' 开；'0'/'false'/空 关）。
// 向后兼容：FLOWX_DRY_RUN 仍被识别（deprecated）。

let _warnedDryRun = false

export function isDryRun(env = process.env) {
  // 优先读新变量；旧变量向后兼容，但发出 deprecation warning（一次性，不刷屏）。
  if (env.FLOWCAST_DRY_RUN != null) {
    const v = env.FLOWCAST_DRY_RUN
    return !!v && v !== '0' && v !== 'false'
  }
  if (env.FLOWX_DRY_RUN != null) {
    if (!_warnedDryRun) {
      _warnedDryRun = true
      console.warn('[flowcast] FLOWX_DRY_RUN 已弃用，请改用 FLOWCAST_DRY_RUN=1')
    }
    const v = env.FLOWX_DRY_RUN
    return !!v && v !== '0' && v !== 'false'
  }
  return false
}
