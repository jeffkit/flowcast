import { defineConfig } from 'vitepress'

// 项目站点部署在 https://jeffkit.github.io/flowx/，base 必须是 /flowx/
export default defineConfig({
  lang: 'zh-CN',
  title: 'flowcast',
  description: '轻量 workflow 编排框架：断点续跑 · HITL · 多 CLI/agent 调度 · 自改沙箱 · 质量门 · L3 codegen 编排',
  base: '/flowx/',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#3c8772' }],
  ],

  themeConfig: {
    logo: undefined,
    outline: { level: [2, 3], label: '本页目录' },

    nav: [
      { text: '指南', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'API 参考', link: '/api/', activeMatch: '/api/' },
      { text: '给 AI 使用', link: '/guide/for-ai', activeMatch: '/guide/for-ai' },
      { text: '速查', link: '/llms.txt', target: '_blank' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'GitHub', link: 'https://github.com/jeffkit/flowx' },
          { text: '更新日志', link: 'https://github.com/jeffkit/flowx/commits/main' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '开始',
          collapsed: false,
          items: [
            { text: '介绍', link: '/guide/introduction' },
            { text: '快速上手', link: '/guide/getting-started' },
            { text: '从零到第一次跑通', link: '/guide/from-zero' },
          ],
        },
        {
          text: '核心概念',
          collapsed: false,
          items: [
            { text: '三层架构', link: '/guide/architecture' },
            { text: '断点续跑（Checkpoint）', link: '/guide/checkpoint' },
            { text: 'HITL 人工介入', link: '/guide/hitl' },
            { text: '质量门与自改沙箱', link: '/guide/quality-gate' },
          ],
        },
        {
          text: '进阶',
          collapsed: false,
          items: [
            { text: 'L3 编排（orchestrate）', link: '/guide/orchestration' },
            { text: 'loop · memory · failure-context', link: '/guide/loop-memory' },
            { text: '配置分层', link: '/guide/configuration' },
            { text: '示例', link: '/guide/examples' },
          ],
        },
        {
          text: '使用与排错',
          collapsed: false,
          items: [
            { text: '给 AI 使用（skill + 速查）', link: '/guide/for-ai' },
            { text: '排错 / FAQ', link: '/guide/troubleshooting' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API 参考',
          collapsed: false,
          items: [
            { text: '总览', link: '/api/' },
            { text: 'Checkpoint', link: '/api/checkpoint' },
            { text: 'Agent 执行', link: '/api/agent' },
            { text: '质量门 / 自改沙箱', link: '/api/quality-gate' },
            { text: 'Provider / Executor', link: '/api/provider-executor' },
            { text: 'Git / Subflow', link: '/api/git-subflow' },
            { text: 'Dashboard', link: '/api/dashboard' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/jeffkit/flowx' },
    ],

    editLink: {
      pattern: 'https://github.com/jeffkit/flowx/edit/main/docs-site/:path',
      text: '在 GitHub 上编辑此页',
    },

    docFooter: { prev: '上一页', next: '下一页' },

    footer: {
      message: '基于 MIT 许可发布',
      copyright: 'Copyright © 2026 jeffkit · flowcast',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '回到顶部',
    langMenuLabel: '切换语言',
    lastUpdated: {
      text: '最后更新于',
    },
  },
})
