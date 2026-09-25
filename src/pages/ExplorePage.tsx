import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Shell'
import { IntentSearch } from '../components/IntentSearch'
import { useCatalog } from '../hooks/useCatalog'

/**
 * `/explore` —— 内容广场。
 *
 * ## ⭐ 这一页补的是方案里**早就写了但没建**的东西
 *
 * 方案 §14.1 的落地页要求三个入口:「我是创作者 / **我是买家** / 看 Agent 自主购买」。
 * 而本页之前,那个「我是买家」**从来不存在** —— 买家必须先拿到 `/p/:id`
 * 链接才能买,没有任何"去哪儿逛逛"的路径。见 `docs/产品流程.md` §5.1。
 *
 * ## 它没有新造任何能力
 *
 * 数据全来自 `GET /api/catalog` —— 那是 W7 给 **agent** 做的端点,
 * 一直在生产上跑,**前端一次没调过**(本页是它第一个前端调用方)。所以这一页是
 * "把已有能力接上",不是"加了个功能"。
 *
 * ## ⚠️ 走的是和 agent 完全相同的目录
 *
 * 人类和机器读的是同一个 `/api/catalog`、同一份价格、同一个
 * `CreatorSplitter.pay()`。这不是巧合,是产品主张:**同一个商品,
 * 两种买家,一份分账**。把这一页做成另一个数据源就毁掉了那句话。
 *
 * ## ⚠️ 2026-09-26(W14 包 A)之后,这一页的渲染被切成两半
 *
 * 搜索区(含它自己的结果网格)搬去了 `components/IntentSearch.tsx`,
 * 商品卡搬去了 `components/ContentCard.tsx`。**本文件只剩三个状态判断**:
 * 读失败 / 还没有内容 / 有内容。分家的理由:搜索结果区和广场网格渲染的是
 * **同一张卡**,复制一份出来第一个漂移的地方就是 `?t=` 标题参数,而它一漂,
 * 付费页就变回「未命名内容」。
 *
 * ## ⚠️ 三个状态必须互相分开(方案 §14.2)
 *
 * | 状态 | 说的是 |
 * |---|---|
 * | 读失败 | 「这不代表没有内容」 |
 * | 链上 0 件 | 「还没有在售的内容」 |
 * | 筛完为空 | 「没有符合条件的在售内容」(在 `IntentSearch` 里) |
 *
 * 混成一个"没有内容"会让用户以为东西没了,而实际上可能只是网络抖了一下。
 */
export function ExplorePage() {
  const query = useCatalog()
  const items = query.data?.items ?? []

  return (
    <>
      <PageHeader
        title="内容广场"
        subtitle={
          <>
            所有在售内容都在这里,价格由创作者定,买断后归你。
            付款时钱按比例<span className="text-neutral-300">直达</span>各创作者钱包 —— 无平台抽成,无资金池。
          </>
        }
        badge={
          <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {items.length > 0 ? `${items.length} 件在售` : '链上目录'}
          </span>
        }
      />

      {query.isLoading && (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="animate-pulse overflow-hidden rounded-2xl border border-line">
              <div className="aspect-[4/3] bg-surface-2" />
              <div className="space-y-2 p-4">
                <div className="h-4 w-2/3 rounded bg-surface-2" />
                <div className="h-3 w-1/3 rounded bg-surface-2" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 读失败 —— 不显示成"没有内容" */}
      {query.isError && (
        <div className="rounded-2xl border border-accent/35 bg-accent/[0.07] px-5 py-4">
          <p className="text-sm text-neutral-100">读链失败</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            网络繁忙 —— 这不代表没有内容。列表来自链上事件,稍后重试即可。
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent"
          >
            重试
          </button>
        </div>
      )}

      {/* 链上一件都没有 —— 明确说"还没有内容",不是一片空列表。
          ⚠️ 这个分支里**不放搜索框**:一件东西都没有的时候,一个只可能筛出
          空结果的框比没有框更让人困惑(判据 §3.4 第 5 条)。 */}
      {!query.isLoading && !query.isError && items.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line px-5 py-14 text-center">
          <p className="text-sm text-neutral-300">还没有在售的内容</p>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
            这个列表读的是链上注册表 —— 有人发布内容并保持上架,它就会出现在这里。
          </p>
          <Link
            to="/create"
            className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-soft"
          >
            我是创作者,去发布
          </Link>
        </div>
      )}

      {/* 有内容 ⇒ 搜索区 + 结果网格整个交给 IntentSearch */}
      {items.length > 0 && <IntentSearch items={items} />}
    </>
  )
}
