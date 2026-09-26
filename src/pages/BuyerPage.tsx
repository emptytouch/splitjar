import type { Hex } from 'viem'
import { Link } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { RefreshCw } from 'lucide-react'
import { Card, PageHeader } from '../components/Shell'
import { ConnectButton } from '../components/ConnectButton'
import { useMyPurchases } from '../hooks/useMyPurchases'
import { formatUsdc } from '../../shared/units'
import { titleText, type RowTitle } from '../lib/contentMeta'
import { shortContentId } from '../lib/splitter'
import { explorerTx, shortHash } from '../lib/links'

/**
 * `/purchased` —— 买家视角的「我的购买」(方案 3)。
 *
 * 数据来自 `useMyPurchases`(按 payer 过滤 PaymentSplit 事件,直接读链,无数据库)。
 * 每一行都是**已购**,点进去走 `/p/:id`,付费页闸门识别 already-owned 直接放行下载。
 * 用 `AppShell`:和 `/explore` 一样是共用面(同一个人既发又买)。
 */
export function BuyerPage() {
  const { isConnected } = useAccount()
  const query = useMyPurchases()
  const rows = query.rows
  const times = query.times

  const totalSpent = rows.reduce((a, r) => a + r.total, 0n)

  return (
    <>
      <PageHeader
        title="我的购买"
        subtitle={
          <>
            每一笔都直接读链上的 <code className="text-neutral-300">PaymentSplit</code> 事件 ——
            <span className="text-neutral-300">没有自己的数据库</span>
            。点任意一件即可查看或重新下载。
          </>
        }
      />

      {!isConnected ? (
        <Card title="先连接钱包" hint="购买记录按付款地址过滤,所以要先知道你是谁">
          <ConnectButton variant="block" />
        </Card>
      ) : (
        <div className="space-y-5">
          {/* ── 汇总 ─────────────────────────────────────────── */}
          <div className="grid gap-5 sm:grid-cols-2">
            <Card title="累计购买">
              <p className="font-mono tnum grad-text text-2xl font-semibold">
                {formatUsdc(totalSpent)}
                <span className="ml-1.5 text-xs font-normal text-muted">USDC</span>
              </p>
              <p className="mt-1.5 text-[11px] text-muted">你花出去的总额</p>
            </Card>
            <Card title="已购内容">
              <p className="font-mono tnum grad-text text-2xl font-semibold">{rows.length}</p>
              <p className="mt-1.5 text-[11px] text-muted">链上事件计数</p>
            </Card>
          </div>

          {/* ── 已购列表 ─────────────────────────────────────── */}
          <Card
            title="已购内容"
            hint="按 PaymentSplit 事件的 payer 过滤 —— 这是链上事实"
            action={
              <button
                type="button"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-300 transition-colors hover:border-accent disabled:opacity-50"
              >
                <RefreshCw
                  className={'h-3 w-3' + (query.isFetching ? ' animate-spin' : '')}
                  aria-hidden
                />
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
                  网络繁忙,这不代表你没有购买 —— 点上面的刷新重试。
                </p>
              </div>
            ) : rows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center">
                <p className="text-sm text-neutral-300">还没有购买过内容</p>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
                  去内容广场逛逛,连钱包付一笔,这里就会立刻多一行 —— 数据来自链上事件。
                </p>
                <Link
                  to="/explore"
                  className="mt-4 inline-block rounded-lg btn-primary px-4 py-2 text-xs font-medium transition-colors"
                >
                  去内容广场
                </Link>
              </div>
            ) : (
              <ul className="space-y-4">
                {rows.map((r) => (
                  <li
                    key={r.contentId}
                    className="rounded-xl border border-line-soft bg-surface-2/40 p-4"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-neutral-100">
                          <RowTitleText title={r.title} />
                        </p>
                        <span className="font-mono text-[11px] text-muted">
                          {shortContentId(r.contentId)}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="font-mono tnum text-sm text-neutral-100">
                          {formatUsdc(r.total)} USDC
                        </p>
                        <p className="text-[11px] text-muted">
                          <a
                            href={explorerTx(r.txHash)}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono underline decoration-line underline-offset-2 hover:decoration-accent"
                          >
                            {shortHash(r.txHash, 6, 4)}
                          </a>
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-[11px] text-muted/70">
                        {times.get(String(r.blockNumber))?.toLocaleString('zh-CN') ??
                          `块 ${r.blockNumber}`}
                      </span>
                      <Link
                        to={purchasePath(r.contentId, r.title)}
                        className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[11px] text-neutral-200 transition-colors hover:border-accent"
                      >
                        查看 / 下载
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-[11px] leading-relaxed text-muted/70">
            时间取自区块时间戳;取不到的显示区块号。链上不存标题,标题来自创作者登记的目录或本机缓存。
          </p>
        </div>
      )}
    </>
  )
}

/**
 * 标题位 —— **四态各画各的**(与看板同一套纪律,理由见 `useMyContents` 文件头)。
 * 不写 `r.title || '未命名内容'`:那是替服务端断言"这件内容没有标题",
 * 其中有一态明明只是"我们没读到"。
 */
function RowTitleText({ title }: { title: RowTitle }) {
  switch (title.k) {
    case 'server':
    case 'local':
      return <>{title.text}</>

    case 'none':
      return <span className="text-muted">未命名内容</span>

    case 'pending':
      return (
        <span
          className="inline-block h-3.5 w-24 animate-pulse rounded bg-line align-middle"
          aria-label="标题载入中"
        />
      )

    case 'unknown':
      return (
        <span
          className="text-muted/70"
          title="标题存在服务端的目录里,这一页现在读不到它 —— 内容本身不受影响"
        >
          标题读不到
        </span>
      )

    default: {
      const never: never = title
      return never
    }
  }
}

/** 已购内容的查看链接(带标题参数,与分享链接同款) */
function purchasePath(contentId: Hex, title: RowTitle): string {
  const t = titleText(title)
  return `/p/${contentId}${t ? `?${new URLSearchParams({ t })}` : ''}`
}
