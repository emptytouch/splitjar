import { useQuery } from '@tanstack/react-query'
import type { PreviewsResponse } from '../../shared/previews'

/**
 * `GET /api/previews` —— 「哪些内容有缩略图」。
 *
 * ## ⚠️ 这个 hook 最重要的东西是它的**三态**,不是它的数据
 *
 * ```
 * urls === null   →  **不知道**(还没拿到 / 读失败 / 服务端没配公开 store)
 * urls.has(id)    →  有
 * !urls.has(id)   →  没有
 * ```
 *
 * 调用方**只能**在"确实是有"和"确实是没有"之间做区分,**"不知道"必须
 * 什么都不画**。理由在下面那段,它比这个 hook 的其余部分都重要。
 *
 * ## ⚠️ 为什么"不知道"绝不能当成"没有"
 *
 * 看板拿这个映射决定要不要显示「补预览图」。把它当成"没有",看板就会在
 * 一个**根本不缺预览图**的内容上显示「补一张」,而创作者照着点下去:
 * 选文件 → 核对 → 派生 → 签一次名 → 然后被平台侧 `allowOverwrite: false`
 * 拒掉(那条路径已经写死了,见 `api/upload.ts` 的 `onBeforeGenerateToken`)。
 * 而**那个拒绝理由到不了前端** —— `@vercel/blob` 的客户端 SDK 拿到非 2xx
 * 时不读响应体,只抛一句笼统的 "Failed to retrieve the client token"
 * (见 `lib/uploadApi.ts` 里 `preflightUpload` 那段)。
 *
 * 于是用户看到的是"文件没能传上去",而他真正的问题是"这张图早就传过了"。
 * 一次白弹的钱包签名 + 一句会骗人的错误 —— 两样都是"沉默的降级"造成的。
 * 所以宁可**不画这个入口**。
 *
 * ## 服务端那边做了同一件事的另一半
 *
 * 公开 store 没配时 `GET /api/previews` 回 **503,不回空对象** ——
 * 否则"我们没配"和"大家都没传"在响应里长得一模一样,这里就无论如何
 * 分不出来了。两处是一件事的两半,见 `api/previews.ts` 文件头。
 */
export function usePreviews() {
  const query = useQuery({
    queryKey: ['previews'],
    queryFn: async (): Promise<Map<string, string>> => {
      const res = await fetch('/api/previews')
      if (!res.ok) {
        // ⚠️ 不去解析 body —— 这一层要分的是"知道 / 不知道",
        // 而所有非 2xx 在这里都是"不知道"。把服务端的错误码搬进来
        // 只会多一层没人读的翻译(与 `useCatalog` 同一个取舍)
        throw new Error(`previews_${res.status}`)
      }
      const body = (await res.json()) as PreviewsResponse
      // 键是小写的 —— 服务端写入时统一过 `toLowerCase()`,那边有注释说明
      // 为什么两端都要各把一次关
      return new Map(Object.entries(body.previews))
    },
    // 与 catalog 同一个量级:只有人传了新预览图才会变。看板自己会在
    // 补图成功之后主动 refetch,不靠这个 staleTime 兜
    staleTime: 30_000,
  })

  return {
    /** `null` = **不知道**。调用方必须按三态处理,见文件头 */
    urls: query.data ?? null,
    refetch: query.refetch,
  }
}
