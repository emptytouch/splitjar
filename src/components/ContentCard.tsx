import { Link } from 'react-router-dom'
import { formatUsdc } from '../../shared/units'
import { shortAddress } from '../lib/links'
import type { CatalogEntry } from '../../shared/agentPay'

/**
 * 一张商品卡 —— 整块可点,直接进付费页。
 *
 * ## ⚠️ 2026-09-26 从 `ExplorePage.tsx` 搬出来(W14 包 A)
 *
 * 对话框的搜索结果区要渲染**和广场一模一样**的卡片 —— 计划 §3.3 第 4 条
 * 就是"复用",而 §3.4 第 4 条判据是"点卡片 ⇒ 付款流程与从广场点进去**完全一致**"。
 * 判据要成立,就不能有两份卡片代码:复制一份出来,第一个会漂移的地方就是
 * `?t=` 那个标题参数 —— 而它一漂,付费页就变回「未命名内容」。
 *
 * ## ⚠️ `?t=` 带上标题的理由
 *
 * 链上**不存标题**,付费页要显示标题就得靠 URL 传(见 `lib/contentMeta.ts`)。
 * 从这一页进去的买家至少有 KV 那份标题,不再依赖谁的 localStorage。
 * (`/dashboard` 的链接用同一个手法。)
 *
 * ## ⚠️ 这里是包 A 与包 B 的**分界线**
 *
 * 点卡片 = 用户自己进付费页、自己签名、自己付钱。**agent 不参与付款**。
 * 「授权后由 agent 替你买」是包 B(W15),**还没开工** —— 别在这张卡上加
 * 任何"替你买"的入口。
 */
export function ContentCard({ item }: { item: CatalogEntry }) {
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
 * ⚠️ 兜底是**正常路径**,不是异常处理:创作者的预览图是 W13 才接上的
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
