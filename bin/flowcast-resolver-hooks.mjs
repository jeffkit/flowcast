/**
 * flowcast ESM resolve hooks（worker thread 侧，由 register() 加载）。
 * 仅重写 `flowcast` → 本包绝对路径，其余 specifier 走默认解析。
 */

let pkgIndex

export function initialize({ pkgIndex: p }) {
  pkgIndex = p
}

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'flowcast' && pkgIndex) {
    return { shortCircuit: true, url: `file://${pkgIndex}` }
  }
  return nextResolve(specifier, context)
}
