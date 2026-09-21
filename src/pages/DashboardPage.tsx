import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { Address, Hex } from 'viem'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { Card, PageHeader } from '../components/Shell'
import { ConnectButton } from '../components/ConnectButton'
import { ClaimPending } from '../components/ClaimPending'
import { DEPLOY_BLOCK } from '../../shared/chain'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { explorerTx, shortAddress, shortHash } from '../lib/links'
import { formatUsdc } from '../lib/units'
import { listRememberedContents } from '../lib/contentMeta'

/**
 * `/dashboard` —— W3 最小版。
 *
 * 上游范围:「`getLogs` 按 creator + 合约地址过滤」。方案 §10 的方案 A
 * (MVP 零额外基建):前端直接 `getLogs` 渲染,不依赖任何索引器。
 *
 * ## `fromBlock` 用部署高度,不从 0 扫
 *
 * 合约只能从部署那一刻起产生事件,所以 `DEPLOY_BLOCK` 是**正确且最小**的起点。
 * 2026-09-21 实测公共 Fuji RPC 不限制 `getLogs` 范围(10 万块一次查完也成功),
 * 所以这一版不需要分页、不需要索引器。等事件多到扫不动时再上 W8 的 KV。
 *
 * ## 谁是"我的内容"
 *
 * `ContentRegistered` 里有 `indexed creator`,直接按 `args.creator` 过滤 ——
 * 这是链上的事实,不依赖本地记录。
 * **标题**是另一回事:合约不存标题,只能从本机缓存取(见 lib/contentMeta.ts)。
 */

type Sale = {
  contentId: Hex
  payer: Address
  txHash: Hex
  blockNumber: bigint
  total: bigint
  myShare: bigint
}

type ContentRow = {
  contentId: Hex
  price: bigint
  txHash: Hex
  blockNumber: bigint
  title: string
  sales: Sale[]
  earned: bigint
}

/**
 * 区块号 → 时间的缓存。同一批销售常常落在少数几个区块里,
 * 每个唯一区块只查一次。上限 24 次 —— 看板不该为了显示时间
 * 打出几十个 RPC 请求(公共端点会限流,方案 §15)。
 */
async function blockTimes(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  numbers: bigint[],
): Promise<Map<string, Date>> {
  const unique = [...new Set(numbers.map(String))].slice(0, 24)
  const out = new Map<string, Date>()
  await Promise.all(
    unique.map(async (n) => {
      try {
        const b = await client.getBlock({ blockNumber: BigInt(n) })
        out.set(n, new Date(Number(b.timestamp) * 1000))
      } catch {
        // 取不到时间就不显示时间 —— 不能让一个装饰性的字段拖垮整个看板
      }
    }),
  )
  return out
}

export function DashboardPage() {
  const { address, isConnected } = useAccount()
  const client = usePublicClient()

  const query = useQuery({
    queryKey: ['dashboard', SPLITTER_ADDRESS, address],
    enabled: Boolean(client && address),
    refetchOnMount: 'always',
    queryFn: async (): Promise<{ rows: ContentRow[]; times: Map<string, Date> }> => {
      const c = client!

      // ① 我创建的内容 —— 直接按 indexed creator 过滤,链上事实
      const registered = await c.getContractEvents({
        address: SPLITTER_ADDRESS,
        abi: creatorSplitterAbi,
        eventName: 'ContentRegistered',
        args: { creator: address },
        fromBlock: DEPLOY_BLOCK,
        toBlock: 'latest',
      })

      const mine = new Map<Hex, { price: bigint; txHash: Hex; blockNumber: bigint }>()
      for (const log of registered) {
        const id = log.args.contentId
        if (!id) continue
        mine.set(id, {
          price: log.args.price ?? 0n,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        })
      }

      // ② 所有分账事件,再按"是不是我创建的 contentId"筛。
      //
      // 为什么不给 getLogs 传 contentId 过滤:那要对每个 contentId 单独查一次。
      // 这些内容总共也没几件,一次全查完再在内存里筛更省请求。
      // (等到事件量真的上来,这一条就该换成 W8 的 KV 索引)
      const allSplits = await c.getContractEvents({
        address: SPLITTER_ADDRESS,
        abi: creatorSplitterAbi,
        eventName: 'PaymentSplit',
        fromBlock: DEPLOY_BLOCK,
        toBlock: 'latest',
      })

      const rows: ContentRow[] = []
      const remembered = new Map(listRememberedContents().map((r) => [r.contentId, r.title]))

      for (const [contentId, meta] of mine) {
        const sales: Sale[] = []

        for (const log of allSplits) {
          if (log.args.contentId !== contentId) continue

          // 分账事件里**自带** recipients/amounts,所以不必再读一次 getContent
          // —— 直接看我这个地址在第几位,取对应的金额
          const recipients = log.args.recipients ?? []
          const amounts = log.args.amounts ?? []
          const idx = recipients.findIndex(
            (r) => r.toLowerCase() === address!.toLowerCase(),
          )
          if (idx === -1) continue // 这笔跟我无关

          sales.push({
            contentId,
            payer: log.args.payer!,
            txHash: log.transactionHash!,
            blockNumber: log.blockNumber!,
            total: amounts.reduce((a, b) => a + b, 0n),
            myShare: amounts[idx] ?? 0n,
          })
        }

        sales.sort((a, b) => Number(b.blockNumber - a.blockNumber))
        rows.push({
          contentId,
          price: meta.price,
          txHash: meta.txHash,
          blockNumber: meta.blockNumber,
          title: remembered.get(contentId) ?? '',
          sales,
          earned: sales.reduce((a, s) => a + s.myShare, 0n),
        })
      }

      rows.sort((a, b) => Number(b.blockNumber - a.blockNumber))
      const times = await blockTimes(
        c,
        rows.flatMap((r) => r.sales.map((s) => s.blockNumber)),
      )
      return { rows, times }
    },
  })

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
            hint="按 ContentRegistered 事件里的 creator 过滤 —— 这是链上事实"
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
                        <p className="truncate text-sm text-neutral-100">
                          {r.title || <span className="text-muted">未命名内容</span>}
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
