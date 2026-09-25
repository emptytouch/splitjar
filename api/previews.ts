import { errorResponse } from '../shared/api.js'
import type { PreviewsResponse } from '../shared/previews.js'
import { loadPreviewUrls, previewsConfigured } from '../server/previews.js'

/**
 * `GET /api/previews` —— 全部预览图的公开地址。
 *
 * ## 它服务的是**创作者**,不是买家
 *
 * 内容看板要判「我这一件在广场上有没有缩略图」,好决定要不要显示
 * 「补预览图」入口。而这个判断只有公开 store 的读侧答得上来 ——
 * 链上不存预览图,私有 store 里只有内容本身。
 *
 * ## ⚠️ 为什么不复用 `GET /api/catalog`
 *
 * 因为 catalog 只列**在售且价 > 0** 的内容(它那边的注释写明了理由:
 * 列出下架内容等于邀请 agent 去烧 gas)。拿它当数据源,一件**已下架**
 * 的内容会被它顺手滤掉,于是看板把"下架了所以不在 catalog 里"读成
 * "没有预览图" —— 一个纯粹由数据源选错造出来的假象。
 *
 * 另外 catalog 是**给 agent 的发现入口**,它返回商品列表是本职;
 * 让它兼职回答"谁有缩略图"会把两件事的演化绑在一起。
 *
 * ## ⚠️ 公开数据,没有鉴权 —— 这一点要想清楚再说"没问题"
 *
 * 返回的是**公开 CDN 上的 URL**:任何人拿到直链本来就能取,而且
 * catalog 对在售内容早就把这些 URL 发出去了。所以这个端点**没有新增
 * 一点信息暴露**,它只是把同一份东西按另一种键排了一次。
 *
 * 诚实记账:它确实比 catalog **多**露出"已下架内容的预览图地址"。
 * 那不是泄露 —— 图还在公开 CDN 上,`list()` 的权限也只由服务端持有;
 * 下架要挡住的是"新买家付钱",不是"这张索引图的存在"。
 *
 * ## ⚠️ 服务端不再二次过滤
 *
 * 这里**只返回全量**,不按调用方给的 contentId 列表筛。理由:筛选要
 * 多一轮输入校验(几十个 contentId 的形状、上限、大小写),而收益只是
 * 少传几十 KB —— 演示量级下这笔交易不划算。真要几百件内容,
 * 该动的是 `list()` 那侧的缓存,不是在这里加参数。
 */
/**
 * ⚠️ **具名 `GET`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 */
export async function GET(): Promise<Response> {
  /**
   * ⚠️ 这一条**必须**在 `loadPreviewUrls()` 之前。
   *
   * 没配公开 store 时它会返回一个**空 Map**,而那与"所有内容都没传过
   * 预览图"在响应里长得一模一样。看板据此会在每一行上都显示「补预览图」,
   * 创作者点了之后必然失败(上传那张门票也签不出来)——
   * 一场由"沉默的降级"造成的、看起来像功能坏了的假象。
   *
   * 所以这里回一个 503 让看板**整个不画这个入口**,而不是回一个空对象。
   * 这与 `loadPreviewUrls` 对 catalog 保持的降级行为**不冲突**:
   * 那边缺了预览图只是少一张索引图,不影响购买。
   */
  if (!previewsConfigured()) {
    return errorResponse(503, 'not_configured', '服务端未配置预览图存储')
  }

  let previews: Map<string, string>
  try {
    previews = await loadPreviewUrls()
  } catch {
    return errorResponse(503, 'upstream_unavailable', '预览图列表暂时不可用')
  }

  /**
   * `Map` → 普通对象。`Object.fromEntries` 在这里是安全的:
   * 键只可能来自 `parseUploadPathname` 拆出来的小写 `0x…`,
   * 形不成 `__proto__` 这种能改原型链的键。
   */
  return Response.json({
    previews: Object.fromEntries(previews),
  } satisfies PreviewsResponse)
}
