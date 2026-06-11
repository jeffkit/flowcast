// dry-run.js — flowx dry-run 模式开关
//
// dry-run 让任意 flow 零成本跑通骨架：执行器（LLM 调用）与质量门（构建）被 fake 成成功，
// git / checkpoint 仍真跑（通常在一次性 temp repo 里）。用途：
//   - L3 codegen harness 的「跑前校验」护栏（validateFlow 用假执行器跑生成的 flow）。
//   - 任何 flow 的结构冒烟（不烧 API、不等构建）。
//
// 开关：环境变量 FLOWX_DRY_RUN（'1'/'true' 开；'0'/'false'/空 关）。

export function isDryRun(env = process.env) {
  const v = env.FLOWX_DRY_RUN
  return !!v && v !== '0' && v !== 'false'
}
