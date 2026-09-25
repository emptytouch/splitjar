import { Link } from 'react-router-dom'
import { PageHeader } from '../components/Shell'
import { useCatalog } from '../hooks/useCatalog'
import { formatUsdc } from '../lib/units'
import { shortAddress } from '../lib/links'
import type { CatalogEntry } from '../../shared/agentPay'

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
 * 一直在生产上跑,**前端一次没调过**。所以这一页是"把已有能力接上",
 * 不是"加了个功能"。
 *
 * ## ⚠️ 走的是和 agent 完全相同的目录
 *
 * 人类和机器读的是同一个 `/api/catalog`、同一份价格、同一个
 * `CreatorSplitter.pay()`。这不是巧合,是产品主张:**同一个商品,
 * 两种买家,一份分账**。把这一页做成另一个数据源就毁掉了那句话。
 *
 * ## 两个状态必须分开(方案 §14.2)
 *
 * **读失败**和**没有内容**是两件事,显示成一样会让用户以为"东西没了"。
 * 读失败时明确说"这不代表没有内容",和 `/dashboard`、控制台摘要同一口径。
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

      {items.length > 0 && (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ContentCard key={item.contentId} item={item} />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * 一张商品卡 —— 整块可点,直接进付费页。
 *
 * ⚠️ `?t=` 带上标题的理由同 `/dashboard` 的链接:链上**不存标题**,
 * 付费页要显示标题就得靠 URL 传(见 `lib/contentMeta.ts`)。
 * 从这一页进去的买家至少有 KV 那份标题,不再依赖谁的 localStorage。
 */
function ContentCard({ item }: { item: CatalogEntry }) {
  const to = `/p/${item.contentId}${item.title ? `?t=${encodeURIComponent(item.title)}` : ''}`

  return (
    <li className="flex">
      <Link
        to={to}
        className="group flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface/70 transition-colors hover:border-accent"
      >
        <Preview item={item} />

        <div className="flex flex-1 flex-col p-4">
          <p className="truncate text-sm text-neutral-100">
            {/* ⚠️ 不能直接渲染 {item.title} —— null 会画成空白,卡片像坏了 */}
            {item.title ?? <span className="text-muted">未命名内容</span>}
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted">
            来自 {shortAddress(item.creator)}
          </p>

          <div className="mt-auto flex items-baseline justify-between pt-4">
            <span className="font-mono tnum text-base font-semibold text-neutral-100">
              {formatUsdc(BigInt(item.price))}
              <span className="ml-1 text-xs font-normal text-muted">USDC</span>
            </span>
            <span className="text-[11px] text-accent-soft opacity-0 transition-opacity group-hover:opacity-100">
              查看并购买 →
            </span>
          </div>
        </div>
      </Link>
    </li>
  )
}

/**
 * 预览图,带兜底。
 *
 * ⚠️ 兜底是**正常路径**,不是异常处理:创作者的预览图是这一版才接上的
 * (`usePublishFlow` 原先写死 `target: 'content'`),所以**在此之前创建的
 * 内容永远没有预览图** —— 而 `catalog` 扫的是链上,历史内容一并列出。
 * 再往前一步:`createContent` 是**公开函数**,绕开我们前端创建的内容
 * 也不会有预览图。多带一个商品绕开,就多一张没有图的卡。
 */
function Preview({ item }: { item: CatalogEntry }) {
  if (!item.previewUrl) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center border-b border-line-soft bg-gradient-to-br from-surface-2 to-ink">
        <span className="text-[11px] text-muted">暂无预览图</span>
      </div>
    )
  }

  return (
    <img
      src={item.previewUrl}
      // 图是装饰,标题才是内容 —— 空 alt 让读屏器跳过它,不重复播报标题
      alt=""
      loading="lazy"
      className="aspect-[4/3] w-full border-b border-line-soft bg-surface-2 object-cover"
    />
  )
}
