import { list } from '@vercel/blob'
import { type CatalogEntry, type CatalogResponse } from '../shared/agentPay.js'
import { errorResponse } from '../shared/api.js'
import { CHAIN } from '../shared/chain.js'
import { deriveActiveState, isActive } from '../shared/contentActive.js'
import { PREVIEW_PREFIX, parseUploadPathname } from '../shared/storage.js'
import { listActiveChanges, listRegisteredContents, publicClient } from '../server/chain.js'
import { serverEnv } from '../server/env.js'
import { getContentTitles } from '../server/kv.js'

/**
 * `GET /api/catalog` —— Agent 的**发现**入口(方案 §9.4 第 0 步)。
 *
 * > 没有这一步,Agent 就得硬编码 URL,演示会显得很假。
 *
 * ## 为什么要扫事件,而不是读某个"列表"函数
 *
 * 合约**没有**"列出所有内容"的函数(已从 ABI 核实:全部函数只有
 * `contentExists` / `createContent` / `getContent` / `pay` / `pendingBalance` /
 * `purchases` / `setContentActive` / `usdc` / `withdraw`)。所以列表只能靠
 * 扫 `ContentRegistered` 事件 —— 起点用 `shared/chain.ts` 的 `DEPLOY_BLOCK`,
 * 那个常数的注释写明"服务端事件索引的起点,**不要另写一份**"。
 *
 * ## ⚠️ 零次 `eth_call` —— 因为 `price` 与 `creator` 注册后不可变
 *
 * 这是本包核实出来的一个便宜:**合约里没有任何改价或转移归属的入口**,
 * 所以 `ContentRegistered` 里那份 `price` / `creator` 永远等于当前值。
 * 逐件调 `getContent` 会更慢,而且**结果完全一样**。
 * 唯一可变的是 `active`,它由 `ContentActiveChanged` 单独记录。
 *
 * ## ⚠️ 三个"缺了也不报错"的字段 —— 这是刻意的
 *
 * | 字段 | 缺的时候 | 为什么不 503 |
 * |---|---|---|
 * | `title` | `null` | 链上不存标题,唯一来源是 KV;没配 KV 或内容建于该端点之前就是没有 |
 * | `previewUrl` | `null` | 创作者可以不上传预览图,没配公开 store 也一样 |
 * | —— | —— | catalog 的**用途是让 agent 能买**,这三样都不阻挡购买 |
 *
 * 退化成 503 会让"没配 KV"这种**和购买无关**的问题把整条 agent 路径打死。
 * 但也要如实说:**`title` 为 `null` 是正常状态,不是错误。**
 */
/**
 * ⚠️ **具名 `GET`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 */
export async function GET(): Promise<Response> {
  let registered: Awaited<ReturnType<typeof listRegisteredContents>>
  let changes: Awaited<ReturnType<typeof listActiveChanges>>
  let blockNumber: bigint
  try {
    // 三条读互不依赖,一起发 —— 它们打的是同一个 RPC,但省掉两次往返的排队
    ;[registered, changes, blockNumber] = await Promise.all([
      listRegisteredContents(),
      listActiveChanges(),
      publicClient.getBlockNumber(),
    ])
  } catch {
    return errorResponse(503, 'upstream_unavailable', '链上查询暂时不可用')
  }

  // 「最后一条事件即当前状态」的推导在 `shared/contentActive.ts` ——
  // ⚠️ 它依赖入参按发生顺序,而 `getContractEvents` 就是这个顺序。
  // 别在这里改成并发按 contentId 分别查,那个顺序不保
  const activeOf = deriveActiveState(changes)

  // ⚠️ **只列在售的,而且只列有价的。**
  // 下架的不该出现在"可买列表"里 —— 合约 `pay()` 对下架内容会 revert,
  // 列出来等于邀请 agent 去烧 gas(与 `/api/content/:id` 回 403 是同一条理由)。
  // 零价内容今天创建不出来(`PriceMustBePositive`),这条是防御性的,别删。
  const sellable = registered.filter((c) => isActive(activeOf, c.contentId) && c.price > 0n)

  // 最新的排前面 —— 列表的常规预期。事件本身按区块升序,翻过来即可。
  // ⚠️ 同一区块内的相对顺序也会被翻(没有可用的时间戳来细分),
  // 这没有正确性影响,只是同块内两条内容的先后。
  sellable.reverse()

  const contentIds = sellable.map((c) => c.contentId)

  // ⚠️ 标题**一次 `mget` 拿完**,不要在这里逐条读 —— catalog 是 agent
  // 每次开始都要打的端点,而逐条读就是 N 次网络往返。见 server/kv.ts
  // 未配置 KV 时返回空 Map,标题全部落成 `null`(正常降级,不是错误)
  let titles = new Map<string, string>()
  try {
    titles = await getContentTitles(contentIds)
  } catch {
    // KV 抖动不该让整个 catalog 挂掉 —— 标题是装饰
  }

  const previews = await loadPreviewUrls().catch(() => new Map<string, string>())

  const items: CatalogEntry[] = sellable.map((c) => ({
    contentId: c.contentId,
    title: titles.get(c.contentId.toLowerCase()) ?? null,
    price: c.price.toString(),
    currency: 'USDC',
    decimals: 6,
    chainId: CHAIN.id,
    creator: c.creator,
    previewUrl: previews.get(c.contentId.toLowerCase()) ?? null,
  }))

  return Response.json({
    items,
    // 这份列表是哪个区块高度上的 —— 排查"刚创建的内容没出现"时用得上
    blockNumber: blockNumber.toString(),
  } satisfies CatalogResponse)
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
 */
async function loadPreviewUrls(): Promise<Map<string, string>> {
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
