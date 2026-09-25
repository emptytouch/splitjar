import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/Shell'
import { ConsolePage } from './pages/ConsolePage'
import { CreatePage } from './pages/CreatePage'
import { DashboardPage } from './pages/DashboardPage'
import { ExplorePage } from './pages/ExplorePage'
import { PayPage } from './pages/PayPage'

/**
 * 路由表 —— 方案 §14.1 定义的那五条,外加一条它漏掉的。
 *
 * | 路由 | 角色 | 状态 |
 * |---|---|---|
 * | `/` | 通用 | 创作者控制台 |
 * | `/explore` | 买家 | ✅ **2026-09-25 新增** |
 * | `/create` | 创作者 | ✅ |
 * | `/p/:id` | 买家 | ✅ **移动端主战场** |
 * | `/dashboard` | 创作者 | ✅ |
 * | `/unlock/:id` | 买家 | ❌ **不是一条路由** —— 解锁在 `/p/:id` 内部走完 |
 *
 * ## ⚠️ 两条与 §14.1 不符的地方,都不是笔误
 *
 * **① `§14.1` 的路由表里没有"发现"这条。** `/explore` 是本仓库补上的第六条。
 * 缺它的后果很具体:买家必须先拿到 `/p/:id` 链接才能买,没有任何浏览路径。
 * 而 §14.1 的落地页那一条其实**要求过**「我是买家」这个入口 ——
 * 要求写了、路由表没有 ⇒ 它从来没被排进任何工作包。见 `docs/产品流程.md` §5.1。
 *
 * **② §14.1 说 `/` 是"通用落地页 + 三个入口",而今天是纯创作者控制台。**
 * 「我是创作者」和「看 Agent 自主购买」两个入口在控制台卡上,
 * 「我是买家」那个原本应该指到这里没有的 `/explore`。
 * ⚠️ **`/` 的定位问题没有解决**,只是买家入口现在有了着落。
 *
 * ## 为什么壳在这一层分
 *
 * `/p/:id` 用 `BuyerShell`(窄、无创作者导航),其余用 `AppShell`(宽、带页签)。
 * 分在路由这一层而不是各自页面里,是为了让"哪条路由属于哪个角色"一眼可见 ——
 * 混在页面内部就得到处翻才知道付费页到底有没有套控制台的导航。
 *
 * ⚠️ `/explore` 归到 `AppShell` 是个**取舍**:买家在这一页会看到创作者页签。
 * 理由是它是共用面(同一个人可以既发又买),且商品网格需要宽度。
 * 如果之后决定买家侧不该出现创作者导航,这一条要重新想 —— 见 `Shell.tsx`。
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
        path="/explore"
        element={
          <AppShell>
            <ExplorePage />
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
