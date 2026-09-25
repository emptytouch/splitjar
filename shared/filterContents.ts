import type { CatalogEntry } from './agentPay.js'
import { USDC } from './chain.js'
import { formatUsdc, parseUsdc } from './units.js'

/**
 * 商品列表的**筛选** —— 关键词 + 价格区间 + 数量上限。
 *
 * ## 为什么住在 `shared/`
 *
 * 与 `shared/previews.ts` 同一个理由:这是**两端都要用**的一段规则,而不是
 * "前端的一个工具函数"。W14 包 A 在前端用它做本地筛选;包 B(授权 agent 扫货)
 * 要在服务端用**同一段**筛,否则"用户在界面上试出来的结果"和"agent 实际买到的"
 * 会出现两套口径 —— 而那种偏差不报错,只是买错了。
 *
 * ## ⚠️ 价格一律走 BigInt,并且"人说的话"和"链上的数"必须分开
 *
 * | 表示 | 长什么样 | 谁产出的 |
 * |---|---|---|
 * | 人类可读 | `"0.5"` | 用户输入、LLM 输出 |
 * | 原始单位 | `500000n` | `CatalogEntry.price`(十进制字符串,`parseUsdc` 一转) |
 *
 * ⚠️ **绝不让 LLM 做 `×10⁶` 这一步。** 它要么算错、要么吐 `5e5` 这种形状,
 * 而算错的症状是"筛出来的东西不对" —— 不报错。所以模型只输出**它听到的那个数**
 * (`"0.5"`),换算留给 `parseUsdc`(全仓唯一一份金额换算,`shared/units.ts`)。
 *
 * ⚠️ 也不许拿字符串比大小(`"100000" < "20000"` 是 `true` —— 字典序)。
 * 更不许 `Number(price)`:`0.2 * 1e6` 在 IEEE 754 下是 `200000.00000000003`。
 * 见 `shared/units.ts` 文件头,那是同一族 bug。
 *
 * ## ⚠️ `title` 为 `null` 是**正常状态**
 *
 * 链上不存标题,唯一来源是 KV。所以带关键词筛选时,**没有标题的内容一件都匹配不上**
 * —— 这是对的,不是 bug:我们连它叫什么都不知道,凭什么说它符合"图"。
 * 反过来,不带关键词时 `null` 标题**照常列出**(价格筛选不需要标题)。
 */

/** 一个可执行的筛选条件。价格是**原始单位**,已经是可比较的整数。 */
export type ContentFilter = {
  /** 关键词,匹配标题(不区分大小写)。`null` = 不筛 */
  keyword: string | null
  /** 价格下限(含)。`null` = 不筛 */
  minRaw: bigint | null
  /** 价格上限(含)。`null` = 不筛 */
  maxRaw: bigint | null
  /** 最多出几件。`null` = 不限 */
  limit: number | null
}

/** 什么都不筛 —— 与"筛完一件不剩"是两件事,别把两者混成一个 `null` */
export const EMPTY_FILTER: ContentFilter = {
  keyword: null,
  minRaw: null,
  maxRaw: null,
  limit: null,
}

/** 关键词长度上限。比 `normalizeTitle` 的标题上限短,长过它的关键词**不可能**匹配到任何标题 */
export const KEYWORD_MAX_LENGTH = 40

/**
 * 把用户在价格框里敲的字符串变成原始单位。
 *
 * 空串 = 这一端不设限(`null`),而不是 0 ——
 * 「最低价 0」和「没填最低价」在筛选上等价,但在**界面文案**上不等价
 * (前者会说"≥ 0 USDC",像一句废话)。
 *
 * ⚠️ 形状不对时**抛 `AmountError`**(原样来自 `parseUsdc`),
 * **不静默当成 0**。用户敲了 `"abc"` 却看到全部结果,是比报错更坏的一种误导。
 */
export function parsePriceBound(input: string, decimals: number = USDC.decimals): bigint | null {
  const s = input.trim()
  if (s === '') return null
  return parseUsdc(s, decimals)
}

/** 关键词归一:去首尾空白、砍到上限。全空白 ⇒ `null`(等于不筛) */
export function normalizeKeyword(input: string): string | null {
  const s = input.trim().slice(0, KEYWORD_MAX_LENGTH)
  return s === '' ? null : s
}

/**
 * 这个筛选条件是不是**什么都没筛** —— 用来决定"要不要显示结果区"。
 *
 * 一件都不筛时不该显示「找到 2 件」这种话:那个数字和广场上的总数一模一样,
 * 说它只是噪音。
 */
export function isEmptyFilter(filter: ContentFilter): boolean {
  return filter.keyword === null && filter.minRaw === null && filter.maxRaw === null && filter.limit === null
}

/**
 * 筛。**保持传入顺序**,不做排序 ——
 *
 * ⚠️ 这条有依赖:`GET /api/catalog` 是**最新在前**(`api/catalog.ts` 里那句
 * `sellable.reverse()`)。所以 `limit` 的语义是**「最新的 N 件」**,不是
 * "随机的 N 件"。**别在这里加排序**:加了之后 `limit` 的含义会跟着变,
 * 而界面上的文案不会。
 *
 * 价格比较用的是**每一件自己的 `decimals`**(不是全局常数)——
 * 今天整个目录都是 6,但 `CatalogEntry` 带着这个字段,说明将来可能有别的。
 * 读它,而不是假设它。
 */
export function filterContents(items: readonly CatalogEntry[], filter: ContentFilter): CatalogEntry[] {
  const needle = filter.keyword === null ? null : filter.keyword.toLowerCase()

  const out = items.filter((item) => {
    if (needle !== null) {
      // 见文件头:没有标题 ⇒ 匹配不上任何关键词。不是错误
      if (item.title === null || !item.title.toLowerCase().includes(needle)) return false
    }

    if (filter.minRaw !== null || filter.maxRaw !== null) {
      const price = BigInt(item.price)
      if (filter.minRaw !== null && price < filter.minRaw) return false
      if (filter.maxRaw !== null && price > filter.maxRaw) return false
    }

    return true
  })

  // ⚠️ `slice(0, 0)` 是空数组 —— 而 `limit: 0` 我们当成"不限"。见 `normalizeLimit`
  return filter.limit === null ? out : out.slice(0, filter.limit)
}

/**
 * LLM 给的数量上限归一。
 *
 * ⚠️ **非正数一律当"不限"(`null`),不当 0。** 一个解析出 `limit: 0` 的模型
 * 只会让界面显示"找到 0 件" —— 而那看起来**和"目录里没有东西"一模一样**,
 * 用户会以为是产品坏了。宁可多列几件。
 */
export function normalizeLimit(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const n = Math.floor(raw)
  if (n <= 0) return null
  return Math.min(n, 100)
}

/**
 * 把筛选条件写成**给人看的一行** —— 「关键词「图」 · ≤ 0.5 USDC」。
 *
 * ⚠️ 它的用途是**回显"我理解成了什么"**。用户说了「0.5 以下的图」,
 * 界面必须让他看见我们把这句话读成了哪几个条件 —— 否则筛错了也没人知道,
 * 而"筛错了"的表现恰好是"结果少了几件",像一个正常的结果。
 */
export function describeFilter(filter: ContentFilter, decimals: number = USDC.decimals): string {
  const parts: string[] = []
  if (filter.keyword !== null) parts.push(`关键词「${filter.keyword}」`)

  if (filter.minRaw !== null && filter.maxRaw !== null) {
    parts.push(`${formatUsdc(filter.minRaw, decimals)} – ${formatUsdc(filter.maxRaw, decimals)} USDC`)
  } else if (filter.maxRaw !== null) {
    parts.push(`≤ ${formatUsdc(filter.maxRaw, decimals)} USDC`)
  } else if (filter.minRaw !== null) {
    parts.push(`≥ ${formatUsdc(filter.minRaw, decimals)} USDC`)
  }

  if (filter.limit !== null) parts.push(`最多 ${filter.limit} 件`)

  return parts.length === 0 ? '全部在售内容' : parts.join(' · ')
}
