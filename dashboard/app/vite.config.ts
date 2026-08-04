import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// 开发态：vite dev server (5173) 代理 /api → 后端 node:http (4173)。
// 构建态：产物输出到 dist/，被 dashboard/server.js 当静态文件托管。
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('.', import.meta.url)),  // dashboard/app
  base: './',                                            // 相对路径，便于任意子路径部署
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
