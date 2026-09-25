import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { Balances } from '../components/Balances'
import { ChainProbe } from '../components/ChainProbe'
import { Card, PageHeader, Placeholder } from '../components/Shell'
import { useMyContents } from '../hooks/useMyContents'
import { formatUsdc } from '../lib/units'
import { shortAddress } from '../lib/links'
import { AGENT_ENTRIES } from '../../shared/agentAddresses'
import { CHAIN } from '../../shared/chain'

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

  const rows = query.rows
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

/** 一行可复制的命令 —— 只有它自己带「复制」,别的都是叙述 */
function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板 API 在非 HTTPS / 无权限时会 reject —— 命令就在上面,能手选
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="w-full rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-left font-mono text-[11px] text-neutral-300 transition-colors hover:border-accent"
      title="点一下复制"
    >
      <span className="text-muted">$ </span>
      {text}
      <span className="float-right text-muted">{copied ? '已复制' : '复制'}</span>
    </button>
  )
}

/**
 * 「Agent 接入」—— 方案 §14.1 那三个入口里的第三个(W8 补上,原先是个假占位)。
 *
 * ## ⚠️ 这张卡**故意没有一个「运行 agent」的按钮**
 *
 * 演示脚本要拿 agent 的**私钥**去签交易。而按方案 §6.2,私钥只存在于
 * **跑脚本那个 shell 的环境变量**里 —— 搬到这里就意味着把私钥放到
 * 服务端或浏览器上(决策 2:私钥不进服务端)。
 *
 * 所以这一格只**说清楚入口和命令**,真正的执行是人在自己终端里敲一行。
 * 这不是"没做完":agent 自主购买本来就不该由一个网页按钮代跑 ——
 * 那样跑起来的是网站,不是 agent。
 *
 * ## 四个动作,全走 HTTP
 *
 * 不需要登录、不需要钱包插件、不需要 SDK —— 一个能发 HTTP 请求的程序就能买。
 */
function AgentAccess() {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-neutral-300">
        机器买家看目录、被拦下、按报价付款、取内容 —— 全程 HTTP,不需要登录,也不需要钱包插件。
      </p>

      <ol className="space-y-1.5 text-[11px] leading-relaxed text-muted">
        <li>
          <span className="font-mono text-neutral-300">GET /api/catalog</span> —— 看有什么可买
        </li>
        <li>
          <span className="font-mono text-neutral-300">GET /api/content/:id</span> —— 不带凭证,得{' '}
          <span className="font-mono text-amber-300/90">402</span> 和一份报价
        </li>
        <li>
          <span className="font-mono text-neutral-300">CreatorSplitter.pay(contentId)</span> ——
          链上付款,钱按比例直达各方
        </li>
        <li>
          <span className="font-mono text-neutral-300">GET /api/content/:id</span> +{' '}
          <span className="font-mono text-neutral-300">X-Payment</span> —— 得{' '}
          <span className="font-mono text-emerald-400">200</span> 与一条短时效直链
        </li>
      </ol>

      <div className="space-y-2 pt-1">
        <p className="text-[11px] text-muted">
          演示脚本(在自己的终端跑,<span className="text-neutral-300">私钥只在那个 shell 里</span>):
        </p>
        <Cmd text="export AGENT_PRIVATE_KEY=0x…" />
        <Cmd text="node scripts/agent-buy.mjs --dry-run" />
        <p className="text-[11px] leading-relaxed text-muted">
          <span className="font-mono">--dry-run</span> 停在付款那一刻之前 ——
          前四步一分钱不花,可以反复跑。去掉它才真的花钱。
        </p>
      </div>

      <p className="border-t border-line-soft pt-3 text-[11px] leading-relaxed text-muted">
        {AGENT_ENTRIES.length > 0 ? (
          <>
            看板上的 [Agent] 徽章<b className="font-medium text-neutral-300">按地址白名单判定</b>,
            不是自动识别。名单在{' '}
            <span className="font-mono text-neutral-300">shared/agentAddresses.json</span>
            {':'}
            {AGENT_ENTRIES.map((e) => (
              <span key={e.address} className="ml-1 font-mono text-neutral-300">
                {shortAddress(e.address)}
              </span>
            ))}
          </>
        ) : (
          <>
            看板上的 [Agent] 徽章<b className="font-medium text-neutral-300">按地址白名单判定</b>,
            不是自动识别 —— 名单(
            <span className="font-mono text-neutral-300">shared/agentAddresses.json</span>
            )现在是空的,所以还没有任何地址会被标成 Agent。
          </>
        )}
      </p>
    </div>
  )
}

/**
 * `/` —— 创作者控制台。
 *
 * ⚠️ 方案 §14.1 说 `/` 应该是「一句话说清 + **三个入口**」的落地页。
 * 前两个入口在「你的内容」那张卡上;第三个(看 Agent 自主购买)W8 补上,
 * 见上面的 `AgentAccess`。
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

          <Card title="Agent 接入" hint="机器支付路径 · HTTP 402">
            <AgentAccess />
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
    </>
  )
}
