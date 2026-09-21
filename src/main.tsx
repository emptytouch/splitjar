import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import App from './App'
import { wagmiConfig } from './lib/wagmi'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/*
      BrowserRouter 放在最外层,而不是里层。
      wagmi / react-query 的 provider 与路由无关,放哪都行 —— 但路由在最外面时,
      将来要在 provider 里读 URL(比如按路由切 RPC)就不用再搬家了。

      ⚠️ 用 BrowserRouter(history API)而不是 HashRouter:
      `vercel.json` 里的 SPA rewrite 已经为路径路由铺好了,
      而 hash 路由会让分享链接变成 `/p/0x…?t=…` → `/#/p/0x…?t=…`,
      二维码会更密,链接也更难念。
    */}
    <BrowserRouter>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </BrowserRouter>
  </StrictMode>,
)
