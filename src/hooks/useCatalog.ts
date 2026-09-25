import { useQuery } from '@tanstack/react-query'
import type { CatalogResponse } from '../../shared/agentPay'

/**
 * `GET /api/catalog` —— 前端第一次读这个端点。
 *
 * ## ⚠️ 这个接口本来是给 agent 做的(W7),前端一次没调过
 *
 * 它返回 `contentId / title / price / creator / previewUrl` —— 一份完整的
 * 商品列表,**已经在生产上跑着**。而在本 hook 之前,用户在界面上
 * **没有任何"去哪儿逛逛"的路径**:必须先拿到 `/p/:id` 链接才能买。
 *
 * 根因不是"没实现",是方案 §14.1 的路由表里**没有"发现"这条** ⇒
 * 它从来没被排进任何工作包。前因后果见 `docs/产品流程.md` §5.1。
 *
 * ## 两个"缺了也不报错"的字段,前端必须各有一套表现
 *
 * `title` 与 `previewUrl` 都可能是 `null`,而且都是**正常状态**,不是错误:
 *
 * | 字段 | 为 null 时 | 界面上怎么显示 |
 * |---|---|---|
 * | `title` | 链上不存标题,唯一来源是 KV | 「未命名内容」,**不能显示空白** |
 * | `previewUrl` | 没人传过预览图 | 一块占位底,**不能显示裂图** |
 *
 * ⚠️ 尤其别把 `title` 直接渲染成 `{title}` —— React 对 `null` 什么都不画,
 * 卡片会变成一张只有价格的空壳,看起来像坏了。
 *
 * ## 没有 query 参数可用
 *
 * `api/catalog.ts` 的签名是 `export async function GET(): Promise<Response>`
 * —— **它不收任何参数**。所以搜索与价格筛选**只能在拿到全量之后在本地做**。
 * 演示量级(链上几件)完全够;真要到几百件,该给那个端点加 query 参数,
 * 而不是在前端硬扛。
 */
export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: async (): Promise<CatalogResponse> => {
      const res = await fetch('/api/catalog')
      if (!res.ok) {
        // ⚠️ 服务端对链上读失败返回 503 + `upstream_unavailable`。
        // 这里不去解析 body —— 页面上要区分的是"读失败"和"没有内容",
        // 状态码已经够判断,而把服务端的错误码搬进 UI 只会多一层翻译。
        throw new Error(`catalog_${res.status}`)
      }
      return (await res.json()) as CatalogResponse
    },
    // 目录变化不快(新建内容才会变),没必要频繁重取
    staleTime: 30_000,
  })
}
