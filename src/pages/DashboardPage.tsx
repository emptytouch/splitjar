import { Link } from 'react-router-dom'
import { useAccount, useReadContract } from 'wagmi'
import { Card, PageHeader } from '../components/Shell'
import { ConnectButton } from '../components/ConnectButton'
import { ClaimPending } from '../components/ClaimPending'
import { ActiveToggle } from '../components/ActiveToggle'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { explorerTx, shortAddress, shortHash } from '../lib/links'
import { formatUsdc } from '../lib/units'
import { useMyContents } from '../hooks/useMyContents'

/**
 * `/dashboard` —— 收入看板 + **我的内容**(含上下架)。
 *
 * 上游范围:「`getLogs` 按 creator + 合约地址过滤」。方案 §10 的方案 A
 * (MVP 零额外基建):前端直接 `getLogs` 渲染,不依赖任何索引器。
 *
 * ## 数据查询已经搬走了
 *
 * 2026-09-23 起,这一页的数据不再自己查 —— 抽到了 `hooks/useMyContents.ts`,
 * 因为控制台(`/`)要显示同一份内容的摘要(开发计划 §12.2)。
 * **一个判断写两遍必然漂移**,所以两个页面共用同一个 hook(同一个 `queryKey`,
 * react-query 自己去重,从控制台点过来不会重扫一遍链)。
 *
 * ## 上下架开关也是在这一页
 *
 * 方案 §5.1 要求创作者可 `setContentActive(contentId, false)`,但此前
 * **全仓库零调用点** —— 内容一旦创建就永远无法下架。开关放在这里而不是
 * 控制台,是因为**列表在这里**:上下架天然长在每一行上,不需要新路由,
 * 也不用动已冻结的 §8.1 接口。
 *
 * ⚠️ 配套改动:`payGate.ts` 里归属判断必须排在下架判断**之前**,否则
 * 买过的人在下架后会失去下载入口 —— 那正好违反"下架不影响已购"这条语义。
 * 两处是一件事的两半,见 `ActiveToggle` 文件头。
 */
export function DashboardPage() {
  const { address, isConnected } = useAccount()
  const query = useMyContents()

  // 待提取余额(W4 的 withdraw 全链路在那一版做,这里只如实显示)
  const pending = useReadContract({
    abi: creatorSplitterAbi,
    address: SPLITTER_ADDRESS,
    functionName: 'pendingBalance',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  const rows = query.data?.rows ?? []
  const times = query.data?.times ?? new Map<string, Date>()
  const totalEarned = rows.reduce((a, r) => a + r.earned, 0n)
  const totalSales = rows.reduce((a, r) => a + r.sales.length, 0)
  const delisted = rows.filter((r) => !r.active).length

  return (
    <>
      <PageHeader
        title="收款"
        subtitle={
          <>
            每一笔都直接读链上的 <code className="text-neutral-300">PaymentSplit</code> 事件 ——
            <span className="text-neutral-300">没有自己的数据库</span>,也就没有"看板和对不上"的可能。
          </>
        }
      />

      {!isConnected ? (
        <Card title="先连接钱包" hint="看板按创建者地址过滤,所以要先知道你是谁">
          <ConnectButton variant="block" />
        </Card>
      ) : (
        <div className="space-y-5">
          {/* ── 汇总 ─────────────────────────────────────────── */}
          <div className="grid gap-5 sm:grid-cols-3">
            <Card title="累计收入">
              <p className="font-mono tnum text-2xl font-semibold">
                {formatUsdc(totalEarned)}
                <span className="ml-1.5 text-xs font-normal text-muted">USDC</span>
              </p>
              <p className="mt-1.5 text-[11px] text-muted">只统计进入你的份额</p>
            </Card>
            <Card title="成交笔数">
              <p className="font-mono tnum text-2xl font-semibold">{totalSales}</p>
              <p className="mt-1.5 text-[11px] text-muted">链上事件计数</p>
            </Card>
            <Card
              title="待提取"
              hint="按当前连上的钱包查 pendingBalance —— 协作者连上时看到的是他自己那份"
            >
              <ClaimPending
                amount={pending.data ?? 0n}
                onClaimed={() => void pending.refetch()}
              />
            </Card>
          </div>

          {/* ── 我的内容 ─────────────────────────────────────── */}
          <Card
            title="我的内容"
            hint={
              delisted > 0
                ? `按 ContentRegistered 事件里的 creator 过滤 · ${delisted} 件已下架`
                : '按 ContentRegistered 事件里的 creator 过滤 —— 这是链上事实'
            }
            action={
              <button
                type="button"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-300 transition-colors hover:border-accent disabled:opacity-50"
              >
                {query.isFetching ? '刷新中…' : '刷新'}
              </button>
            }
          >
            {query.isLoading ? (
              <div className="animate-pulse space-y-3" aria-busy="true">
                <div className="h-14 rounded-xl bg-surface-2" />
                <div className="h-14 rounded-xl bg-surface-2" />
              </div>
            ) : query.isError ? (
              <div className="rounded-xl border border-accent/35 bg-accent/[0.07] px-4 py-3">
                <p className="text-sm text-neutral-100">读链失败</p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  网络繁忙,{/* 方案 §14.2:不得显示成"没有数据" */}这不代表你没有内容 ——
                  点上面的刷新重试。
                </p>
              </div>
            ) : rows.length === 0 ? (
              /* 方案 §14.2:「空看板:无订单时给引导而非空白」 */
              <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center">
                <p className="text-sm text-neutral-300">还没有创建过内容</p>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
                  创建一件付费内容之后,买家每付一笔,这里就会立刻多一行 ——
                  数据来自链上事件,不需要任何同步。
                </p>
                <Link
                  to="/create"
                  className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-soft"
                >
                  创建第一件内容
                </Link>
              </div>
            ) : (
              <ul className="space-y-4">
                {rows.map((r) => (
                  <li key={r.contentId} className="rounded-xl border border-line-soft bg-surface-2/40 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-100">
                          <span className="truncate">
                            {r.title || <span className="text-muted">未命名内容</span>}
                          </span>
                          {/*
                            已下架的状态必须比标题更早被看到 —— 否则创作者会疑惑
                            "为什么没人买"。方案 §14.2 要求买家侧显示"已下架",
                            创作者侧同理:他自己也得知道。
                          */}
                          {!r.active && <StatusBadge label="已下架" tone="warn" />}
                        </p>
                        <Link
                          to={`/p/${r.contentId}${r.title ? `?t=${encodeURIComponent(r.title)}` : ''}`}
                          className="font-mono text-[11px] text-muted underline decoration-line underline-offset-2 hover:decoration-accent"
                        >
                          {r.contentId.slice(0, 18)}…
                        </Link>
                      </div>
                      <div className="text-right">
                        <p className="font-mono tnum text-sm text-neutral-100">
                          {formatUsdc(r.earned)} USDC
                        </p>
                        <p className="text-[11px] text-muted">
                          定价 {formatUsdc(r.price)} · {r.sales.length} 笔
                        </p>
                      </div>
                    </div>

                    {/*
                      ⚠️ 直接子元素,不能在 flex 行里 —— 它内部除了按钮还有一个
                      会占满宽度的状态说明面板。理由见 `ActiveToggle` 的注释。
                    */}
                    <ActiveToggle
                      contentId={r.contentId}
                      active={r.active}
                      onChanged={() => void query.refetch()}
                    />

                    {r.sales.length > 0 && (
                      <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-3">
                        {r.sales.map((s) => (
                          <li
                            key={`${s.txHash}-${s.payer}`}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]"
                          >
                            <span className="flex items-baseline gap-2 text-muted">
                              <span className="text-emerald-400">+{formatUsdc(s.myShare)}</span>
                              <a
                                href={explorerTx(s.txHash)}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono underline decoration-line underline-offset-2 hover:decoration-accent"
                              >
                                {shortHash(s.txHash, 6, 4)}
                              </a>
                              <span className="font-mono">来自 {shortAddress(s.payer)}</span>
                            </span>
                            <span className="text-muted/70">
                              {times.get(String(s.blockNumber))?.toLocaleString('zh-CN') ?? `块 ${s.blockNumber}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-[11px] leading-relaxed text-muted/70">
            时间取自区块时间戳;取不到的显示区块号。
            买家类型标注(人类 / Agent)是 W8 —— 现在两者走的是同一个{' '}
            <code>PaymentSplit</code> 事件,方案 §10 说得很清楚,看板天然能看到,只差标注。
          </p>
        </div>
      )}
    </>
  )
}

/** 行内状态小标签 */
function StatusBadge({ label, tone }: { label: string; tone: 'warn' }) {
  const tones = {
    warn: 'border-amber-400/35 bg-amber-400/[0.08] text-amber-300/90',
  } as const

  return (
    <span
      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-normal ${tones[tone]}`}
    >
      {label}
    </span>
  )
}
