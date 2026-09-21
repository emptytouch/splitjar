import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useAccount } from 'wagmi'
import { ConnectButton } from '../components/ConnectButton'
import { PayStatus } from '../components/PayStatus'
import { ShareQr } from '../components/ShareQr'
import { BuyerShell } from '../components/Shell'
import { CHAIN } from '../../shared/chain'
import { buildShareUrl, getRememberedContent, readTitleParam } from '../lib/contentMeta'
import { formatBps, formatUsdc, previewShares } from '../lib/units'
import { explorerAddress, shortAddress } from '../lib/links'
import { normalizeContentId } from '../lib/splitter'
import { usePayFlow } from '../hooks/usePayFlow'

/**
 * 买家付费页 —— 方案 §14.1 标注的「移动端主战场」。
 *
 * 三条从方案里来的硬要求,在这里落地:
 *
 * ① §15「付费页首屏不得白屏」→ 内容没读完时给骨架屏,不是空白。
 * ② §5.1 / §19「必须在付费页**购买前**显著提示'数字内容,一经售出概不退款'」
 *    → 落在付款按钮的下方,付款之前一定看得见。
 * ③ §14.1「付费页**移动端主战场**」→ 用 `BuyerShell` 的 `max-w-md`,
 *    桌面是增强(多一列二维码),不是默认。
 */

/** 骨架屏。方案 §14.2 明确要求「加载中:骨架屏,付费页首屏不得白屏」 */
function Skeleton() {
  return (
    <div className="animate-pulse space-y-5" aria-busy="true" aria-label="加载中">
      <div className="h-6 w-3/5 rounded-md bg-surface-2" />
      <div className="h-10 w-2/5 rounded-md bg-surface-2" />
      <div className="h-24 rounded-xl bg-surface-2/70" />
      <div className="h-12 rounded-xl bg-surface-2/70" />
    </div>
  )
}

function Notice({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface/70 p-6 text-center">
      <p className="text-sm text-neutral-200">{title}</p>
      {hint && <p className="mt-2 text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  )
}

/** 分账明细。收款方地址 == 内容 creator 的那一方标成「创作者」 */
function SplitTable({
  recipients,
  splits,
  price,
  creator,
}: {
  recipients: readonly `0x${string}`[]
  splits: readonly number[]
  price: bigint
  creator: `0x${string}`
}) {
  // 与合约同款的余数规则 —— 见 units.ts 的 previewShares。
  // 这里显示的金额必须和链上真正到账的一分不差,否则用户对不上账
  const amounts = useMemo(() => previewShares(price, splits), [price, splits])

  return (
    <ul className="space-y-2">
      {recipients.map((addr, i) => (
        <li key={`${addr}-${i}`} className="flex items-baseline justify-between gap-3 text-xs">
          <span className="flex items-baseline gap-2">
            <span className="text-neutral-300">
              {addr.toLowerCase() === creator.toLowerCase() ? '创作者' : '协作者'}
            </span>
            <a
              href={explorerAddress(addr)}
              target="_blank"
              rel="noreferrer"
              className="font-mono tnum text-muted underline decoration-line underline-offset-2 hover:decoration-accent"
            >
              {shortAddress(addr)}
            </a>
          </span>
          <span className="shrink-0">
            <span className="text-neutral-200">{formatUsdc(amounts[i])}</span>
            <span className="ml-2 text-muted">{formatBps(splits[i])}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function PayPage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const contentId = normalizeContentId(id)

  const flow = usePayFlow(contentId)
  const { chainId, isConnected } = useAccount()

  /**
   * 标题来自两处,**都不是链上**(合约没这个字段,见 lib/contentMeta.ts 的说明):
   * ① 分享链接的 `?t=` —— 买家打开就能看到
   * ② 创建者本机的 localStorage —— 用于他自己回看,以及链接里没带标题时兜底
   *
   * ⚠️ 它**纯粹用于展示**,不参与任何校验。价格和分账一律从链上读。
   */
  const title =
    readTitleParam(params) || (contentId ? (getRememberedContent(contentId)?.title ?? '') : '')

  const onFuji = isConnected && chainId === CHAIN.id

  if (!contentId) {
    return (
      <BuyerShell>
        <Notice
          title="链接无效"
          hint="这个付费链接看起来不完整。跟创作者要一下完整链接,或者直接扫他给的二维码。"
        />
      </BuyerShell>
    )
  }

  const content = flow.content
  const price = content?.price

  return (
    <BuyerShell>
      {flow.isReading ? (
        <Skeleton />
      ) : !content ? (
        <Notice title="内容不存在" hint="创作者可能已删除,或链接里的编号抄错了一位。" />
      ) : (
        <div className="space-y-5">
          {/* ── 这是什么、多少钱 ─────────────────────────────── */}
          <div>
            <h1 className="text-xl font-semibold leading-snug tracking-tight">
              {title || '付费内容'}
            </h1>
            <p className="mt-2 flex items-baseline gap-2">
              <span className="font-mono tnum text-3xl font-semibold tracking-tight">
                {formatUsdc(price!)}
              </span>
              <span className="text-sm text-muted">USDC</span>
            </p>
            {!title && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted/70">
                分享链接里没带标题,所以这里只显示链上的价格。
              </p>
            )}
          </div>

          {/* ── 分账明细:这是产品的核心卖点,放在最显眼的地方 ── */}
          <div className="rounded-2xl border border-line bg-surface/70 p-4">
            <p className="mb-3 text-[11px] tracking-wide text-muted">
              付完之后,钱按这个比例直达各方的钱包 —— 无平台抽成,无资金池
            </p>
            <SplitTable
              recipients={content.recipients}
              splits={content.splits}
              price={price!}
              creator={content.creator}
            />
          </div>

          {/* ── 状态与主按钮 ─────────────────────────────────── */}
          <PayStatus state={flow.state} needsApprove={flow.needsApprove} />

          {flow.state.k !== 'success' && (
            <>
              {!isConnected ? (
                <div className="space-y-3">
                  <ConnectButton variant="block" />
                  <p className="text-center text-[11px] leading-relaxed text-muted">
                    没有钱包?用手机上装了 Core 或 MetaMask 的浏览器打开这个链接。没有 USDC
                    也没关系,测试网的可以免费领。
                  </p>
                </div>
              ) : !onFuji ? (
                <ConnectButton variant="block" />
              ) : (
                <button
                  type="button"
                  onClick={flow.pay}
                  disabled={
                    flow.state.k !== 'idle' &&
                    flow.state.k !== 'blocked' &&
                    flow.state.k !== 'failed'
                  }
                  className="w-full rounded-xl bg-accent px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {flow.state.k === 'idle'
                    ? `付款 ${formatUsdc(price!)} USDC`
                    : flow.state.k === 'checking'
                      ? '检查中…'
                      : flow.state.k === 'signing'
                        ? '等待钱包确认…'
                        : flow.state.k === 'pending'
                          ? '上链中…'
                          : flow.state.k === 'confirming'
                            ? '确认中…'
                            : '重新检查'}
                </button>
              )}
            </>
          )}

          {/* ── §5.1 / §19:购买前必须显著提示不退款 ───────────── */}
          {flow.state.k !== 'success' && (
            <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-4 py-3 text-[11px] leading-relaxed text-amber-200/90">
              <span className="font-medium">数字内容,一经售出概不退款。</span>
              {' '}付款会按上面的比例立刻分给各方,链上交易不可撤销。
            </p>
          )}

          {/* ── 二维码:只在宽屏。手机打开时它自己就是那个页面 ── */}
          <div className="hidden justify-center border-t border-line-soft pt-6 sm:flex">
            <ShareQr
              url={buildShareUrl(contentId, title)}
              caption="用手机扫这个码,在手机上完成付款"
            />
          </div>
        </div>
      )}
    </BuyerShell>
  )
}
