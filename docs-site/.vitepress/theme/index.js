// flowcast 自定义主题入口
//
// 扩展 VitePress 默认主题：
//   1. 引入 custom.css —— 覆盖 --vp-c-brand-* 等变量，全站绿色品牌化
//   2. wrap 默认 <Layout/> —— 在首页 Hero 插槽注入沉浸背景组件
//
// 参考：https://vitepress.dev/guide/extending-default-theme

import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './custom.css'

import HomeHeroBackground from './components/HomeHeroBackground.vue'

export default {
  extends: DefaultTheme,
  Layout: () => {
    return h(DefaultTheme.Layout, null, {
      // 首页 Hero 图像区插槽：注入网格 + 光晕背景
      'home-hero-image': () => h(HomeHeroBackground),
    })
  },
}
