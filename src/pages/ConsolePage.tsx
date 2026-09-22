import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { Balances } from '../components/Balances'
import { ChainProbe } from '../components/ChainProbe'
import { Card, PageHeader, Placeholder } from '../components/Shell'
import { useMyContents } from '../hooks/useMyContents'
import { formatUsdc } from '../lib/units'
import { CHAIN } from '../../shared/chain'

/** W1 的完成定义,直接长在页面上 —— 打开就知道还差哪一步(开发计划 W1) */
function Checklist() {
  const { isConnected, chainId } = useAccount()
  const onFuji = isConnected && chainId === CHAIN.id

  const items: Array<[boolean, string]> = [
    [true, '页面构建通过'],
    [isConnected, '连上钱包'],
    [onFuji, `在 ${CHAIN.name} 上`],
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {items.map(([done, label]) => (
        <span key={label} className="flex items-center gap-2 text-xs">
          <span className={done ? 'text-emerald-400' : 'text-muted'}>{done ? '✓' : '○'}</span>
          <span className={done ? 'text-neutral-300' : 'text-muted'}>{label}</span>
        </span>
      ))}
      <span className="ml-auto text-[11px] text-muted">W1 完成定义 · 开发计划</span>
    </div>
  )
}

/**
 * 「你的内容」的摘要 —— 控制台只给**入口和概览**,明细在 `/dashboard`。
 *
 * ## 这里原本是一张占位卡,而且它说的理由是错的(2026-09-23 修)
 *
 * 原文案写「W3 起 —— 列表与上下架在 W4」。两处都不对:
 *
 * 1. **W4 从来没有这个任务。** `W4-实施计划.md` 是「分账完整化(3 方 + 存证
 *    + escrow 验证)」,grep「列表 / 上下架」零命中;
 * 2. **方案 §14.1 的路由表里根本没有"内容列表"这条路由** —— 所以它从来
 *    没被排进过任何一周。而**列表其实早就做好了**,在 `/dashboard`。
 *
 * 于是这张卡当时的状态是:一个通往 `/create` 的按钮 + 一句错误的承诺,
 * 而它声称的东西在另一个页面上跑着。现在改成**真摘要**:件数、累计收入、
 * 有没有已下架的,外加一个「管理内容 →」。
 *
 * 用的是和 `/dashboard` **同一个 hook**(`useMyContents`),所以:
 * - 不是"另查一遍"(同一个 `queryKey`,react-query 去重);
 * - 数字天然一致,不会出现两个页面各说各话。
 *
 * ⚠️ 一件**没做进摘要**的事:标题来自本机 localStorage(`lib/contentMeta.ts`),
 * 而**链上不存标题**。所以这里只报**件数和金额**(纯链上事实),
 * 不报"最近创建的是 XXX" —— 换台机器那句话就是空的。
 */
function ContentSummary() {
  const { isConnected } = useAccount()
  const query = useMyContents()

  if (!isConnected) {
    return <Placeholder note="连上钱包后,这里会显示你创建了几件内容、累计收了多少" />
  }

  if (query.isLoading) {
    return (
      <div className="animate-pulse space-y-3" aria-busy="true">
        <div className="h-10 rounded-xl bg-surface-2" />
      </div>
    )
  }

  // 方案 §14.2:读失败**不得显示成"没有数据"** —— 两者对用户的含义完全不同
  if (query.isError) {
    return (
      <div className="rounded-xl border border-accent/35 bg-accent/[0.07] px-4 py-3">
        <p className="text-sm text-neutral-100">读链失败</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          网络繁忙,这不代表你没有内容 —— 去「管理内容」那一页可以重试。
        </p>
      </div>
    )
  }

  const rows = query.data?.rows ?? []
  if (rows.length === 0) {
    return <Placeholder note="还没有创建过内容 —— 点右上角「创建付费内容」开始" />
  }

  const totalEarned = rows.reduce((a, r) => a + r.earned, 0n)
  const totalSales = rows.reduce((a, r) => a + r.sales.length, 0)
  const delisted = rows.filter((r) => !r.active).length

  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
      <Stat label="内容" value={String(rows.length)} unit="件" />
      <Stat label="成交" value={String(totalSales)} unit="笔" />
      <Stat label="累计收入" value={formatUsdc(totalEarned)} unit="USDC" />
      {delisted > 0 && (
        <span className="text-[11px] text-amber-300/90">
          其中 {delisted} 件已下架 —— 已有付款不受影响
        </span>
      )}
    </div>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mt-0.5 font-mono tnum text-lg font-semibold text-neutral-100">
        {value}
        <span className="ml-1 text-xs font-normal text-muted">{unit}</span>
      </p>
    </div>
  )
}

/**
 * `/` —— 创作者控制台。
 *
 * ⚠️ 方案 §14.1 说 `/` 应该是「一句话说清 + **三个入口**」的落地页。
 * 这一版**故意没做** —— 第三个入口(看 Agent 自主购买)对应的是 W7 的
 * `/api/catalog`,现在做就等于挂一个假按钮。**W7 时改**。
 */
export function ConsolePage() {
  return (
    <>
      <PageHeader
        title="创作者控制台"
        subtitle={
          <>
            定好价格和分账比例,上传内容,拿到一个付费页。买家付稳定币,钱按比例
            <span className="text-neutral-300">直达</span>各方钱包 —— 无平台抽成,无资金池。
          </>
        }
        badge={
          <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {CHAIN.name} · chainId {CHAIN.id}
          </span>
        }
      />

      <div className="space-y-5">
        <Card title="账户" hint="演示账户的状态,以及自动读取的 Fuji 链上参数">
          <Balances />
        </Card>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card
            title="链上探针"
            hint="用钱包实付口径结算一笔分账的 gas,它决定演示定价"
            className="lg:col-span-2"
          >
            <ChainProbe />
          </Card>

          <Card title="Agent 接入" hint="机器支付路径">
            <Placeholder note="W7 起 —— /api/catalog + HTTP 402 报价" />
          </Card>
        </div>

        <Card
          title="你的内容"
          hint="创建与定价在「创建付费内容」;列表与上下架在「管理内容」"
          action={
            <div className="flex shrink-0 items-center gap-2">
              <Link
                to="/dashboard"
                className="rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent"
              >
                管理内容
              </Link>
              <Link
                to="/create"
                className="rounded-lg bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-soft"
              >
                创建付费内容
              </Link>
            </div>
          }
        >
          <ContentSummary />
        </Card>
      </div>

      <div className="mt-5 rounded-2xl border border-line-soft bg-surface/40 px-5 py-4">
        <Checklist />
      </div>
    </>
  )
}
