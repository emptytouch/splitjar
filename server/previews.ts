import { list } from '@vercel/blob'
import { PREVIEW_PREFIX, parseUploadPathname } from '../shared/storage.js'
import { serverEnv } from './env.js'

/**
 * 「哪些内容有预览图」—— **公开 store 的读侧**。
 *
 * ## ⚠️ 2026-09-25 从 `api/catalog.ts` 搬到这里
 *
 * 原先它是 `api/catalog.ts` 里的一个私有函数。看板要判「这一件有没有缩略图」
 * 时,它有了**第二个调用点** —— 而照抄一份到看板那条路正是这个仓库一直在
 * 反对的事(「一个判断写两遍必然漂移」,见 `hooks/useMyContents.ts` 文件头)。
 *
 * 但搬出来之后有个**行为差别必须写清楚**,别以为两处的语义完全一样:
 * 对 catalog 来说"没有预览图"是可以接受的降级(那一格画个占位底),
 * 对看板来说**"读不到"和"没有"必须分开** —— 把"读不到"当成"没有",
 * 看板会在一个根本不缺预览图的内容上显示「补一张」,而创作者点了之后
 * 会被平台的防覆盖拒掉(见 `api/previews.ts` 文件头)。所以那边拿不到
 * 列表时**不画这个入口**,而不是画一个空的。
 */

/**
 * 公开 store 配了没有。
 *
 * ⚠️ 存在的理由:`loadPreviewUrls` 在没配 store 时返回**空 Map**,
 * 而空 Map 和"所有内容都没传过预览图"在调用方看来一模一样。
 * 对 catalog 无所谓,对看板是一场骗局 —— 所以那条路要先问这一句,
 * 好在**返回空 Map 之前**就把"我们根本没配"和"大家都没传"分开。
 */
export function previewsConfigured(): boolean {
  return Boolean(serverEnv('PUBLIC__READ_WRITE_TOKEN'))
}

/**
 * 一次性把**所有**预览图的公开 URL 捞出来,收成 `contentId(小写) → url`。
 *
 * ## ⚠️ 为什么用 `list()` 而不是手拼 URL
 *
 * 仓库里**没有**公开 store 的 base URL 环境变量,而 store 的域名形如
 * `<storeId>.public.blob.vercel-storage.com/...`。手拼意味着把 storeId
 * 写进代码或再加一个环境变量 —— 而 `list()` 的返回项**自带完整的 `url` 字段**。
 *
 * **一次调用拿全部**,不是每件内容查一次。
 *
 * ## ⚠️ 必须翻页
 *
 * `list()` 一次只返回一页(默认 1000 条),`hasMore` / `cursor` 要自己跟。
 * 不翻页的失败模式很隐蔽:内容超过一页之后,**靠后的那些会静默地没有预览图**
 * —— 看起来像"这几件没传预览图",而不是"我们少读了一页"。
 *
 * ## ⚠️ 没配 store 时返回**空 Map**,而这和"大家都没传"长得一样
 *
 * 这是刻意的降级(catalog 的 `previewUrl` 本来就可以为 `null`)。
 * 会介意这个歧义的调用方请先问 `previewsConfigured()`。
 */
export async function loadPreviewUrls(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const token = serverEnv('PUBLIC__READ_WRITE_TOKEN')
  // 没配公开 store 就不查 —— 预览图全部落成 `null`,这是正常降级
  if (!token) return out

  let cursor: string | undefined
  // 安全阀:一页 1000 条,20 页 = 2 万件内容。演示量级下永远到不了,
  // 但"循环没有上界"是一个不该留在生产路径里的形状
  for (let page = 0; page < 20; page++) {
    const result = await list({ token, prefix: PREVIEW_PREFIX, cursor })
    for (const blob of result.blobs) {
      // ⚠️ 用 `parseUploadPathname` 拆,不要自己切字符串 —— 它同时保证了
      // "这条路径确实形如 `preview/0x…`"。公开 store 里理论上只会有预览图,
      // 但"理论上有"不是校验
      const parsed = parseUploadPathname(blob.pathname)
      if (!parsed || parsed.target !== 'preview') continue
      out.set(parsed.contentId.toLowerCase(), blob.url)
    }
    if (!result.hasMore) break
    cursor = result.cursor
    if (!cursor) break
  }
  return out
}
