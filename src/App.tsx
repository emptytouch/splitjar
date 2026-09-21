import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/Shell'
import { ConsolePage } from './pages/ConsolePage'
import { CreatePage } from './pages/CreatePage'
import { DashboardPage } from './pages/DashboardPage'
import { PayPage } from './pages/PayPage'

/**
 * 路由表 —— 方案 §14.1 定义的那五条,这一版落地其中四条。
 *
 * | 路由 | 角色 | W3 |
 * |---|---|---|
 * | `/` | 通用 | 创作者控制台(§14.1 的落地页留到 W7) |
 * | `/create` | 创作者 | ✅ |
 * | `/p/:id` | 买家 | ✅ **移动端主战场** |
 * | `/dashboard` | 创作者 | ✅ |
 * | `/unlock/:id` | 买家 | ⬜ W5(存储与门禁) |
 *
 * ## 为什么壳在这一层分
 *
 * `/p/:id` 用 `BuyerShell`(窄、无创作者导航),其余三个用 `AppShell`(宽、带页签)。
 * 分在路由这一层而不是各自页面里,是为了让"哪条路由属于哪个角色"一眼可见 ——
 * 混在页面内部就得到处翻才知道付费页到底有没有套控制台的导航。
 */
export default function App() {
  return (
    <Routes>
      {/* 买家页:自己的壳 */}
      <Route path="/p/:id" element={<PayPage />} />

      {/* 创作者页:控制台的壳 */}
      <Route
        path="/"
        element={
          <AppShell>
            <ConsolePage />
          </AppShell>
        }
      />
      <Route
        path="/create"
        element={
          <AppShell>
            <CreatePage />
          </AppShell>
        }
      />
      <Route
        path="/dashboard"
        element={
          <AppShell>
            <DashboardPage />
          </AppShell>
        }
      />

      {/* 未匹配的一律回控制台 —— 静态托管的 SPA rewrite 会把任意路径都送到这里 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
