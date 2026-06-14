/**
 * flowcast ESM resolve hook — 由 flowcast run 通过 --import 注入。
 * 把 `flowcast` 解析到本包的绝对路径，
 * 使业务 flow 文件无需 package.json / node_modules 即可 import 包名。
 *
 * 环境变量 FLOWCAST_PKG_INDEX 由 flowcast run 在 spawn 前写入。
 */
import { register } from 'module'
import { pathToFileURL } from 'url'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const hooksFile = pathToFileURL(
  dirname(fileURLToPath(import.meta.url)) + '/flowcast-resolver-hooks.mjs'
).href

register(hooksFile, { data: { pkgIndex: process.env.FLOWCAST_PKG_INDEX ?? process.env.FLOWX_PKG_INDEX } })
