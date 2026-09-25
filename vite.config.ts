import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  /**
   * ⚠️ **本机开发必须同时起两个进程**,前端在 :5173 才有数据:
   *
   * ```
   * vercel dev          # 起 /api/*,默认 :3000
   * npm run dev         # 起前端 :5173(走下面的代理)
   * ```
   *
   * ## 为什么非加不可
   *
   * `/api/*` 是 Vercel Functions,**只有 `vercel dev` 会提供它们**。
   * 没有这条代理时,:5173 上请求 `/api/catalog` 会命中 Vite 的 SPA
   * 回退,拿到一份 **HTML**(`index.html`)—— 而且 `fetch` 是 **200 成功**,
   * 直到 `res.json()` 才炸成一句看不懂的 `Unexpected token '<'`。
   *
   * `/explore` 是本仓库**第一个内容全部来自 `/api` 的页面** ——
   * 在它之前,`/dashboard` 和付费页读的都是链上 RPC(前端直连,不经自己的服务端),
   * 所以这个坑一直没被踩到。
   *
   * ⚠️ **别把 :3000 当成前端页面用**:`vercel.json` 的 rewrite
   * `"/((?!api/).*)" → /index.html` 会把 `/src/*.tsx` 这类真实文件路径
   * 也一并吞成 HTML,页面看起来是白屏而不是报错。看界面一律用 :5173。
   */
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
