import { useState, type ReactNode } from 'react'
import { formatEther, formatGwei } from 'viem'
import { useGasPrice } from 'wagmi'
import { CHAIN, ESTIMATED_PAY_GAS, WALLET_DEFAULT_TIP } from '../../shared/chain'
import { num, pct } from '../lib/format'

const DEMO_PRICE = 0.2 // 演示定价,由下面这道门槛推出来的(开发计划 5.3)

const LABEL = 'text-[11px] text-muted'
const VALUE = 'tnum whitespace-nowrap font-mono text-2xl font-medium text-neutral-50'

/**
 * 链上探针 —— 结算"一笔分账的 gas 成本",它决定演示定价。
 *
 * ⚠️ 这里最容易骗人的地方是**用哪个 gasPrice**。
 * 节点建议价(`eth_gasPrice`)在 Fuji 上只报 160 wei;但钱包点确认发出去的交易,
 * 实测 effectiveGasPrice 是 1,000,000,010 wei —— **差 600 万倍**。
 * 拿节点建议价去算,$0.05 的定价会显示"只占 7.7e-7%,轻松过关",而那是假的。
 *
 * 所以口径必须可切换且默认选**钱包**那档。详见 shared/chain.ts 的 WALLET_DEFAULT_TIP。
 *
 * 显示一律走 viem 的 format* 字符串再经 num() 压短,**不做 Number 往返** ——
 * `Number("0.000000001").toLocaleString()` 会显示成 "0",正好藏掉要看的那位数。
 */
export function ChainProbe() {
  const { data: gasPrice, isLoading, error } = useGasPrice()
  const [avaxUsd, setAvaxUsd] = useState('20')
  const [viaWallet, setViaWallet] = useState(true)

  // 节点建议价 vs 钱包实付价 —— 钱包那档取两者较大值
  const suggested = gasPrice
  const effective =
    suggested === undefined
      ? undefined
      : viaWallet
        ? suggested > WALLET_DEFAULT_TIP
          ? suggested
          : WALLET_DEFAULT_TIP
        : suggested

  const perPayWei = effective !== undefined ? effective * ESTIMATED_PAY_GAS : undefined
  const gasLabel = effective !== undefined ? num(formatGwei(effective)) : undefined
  const costLabel = perPayWei !== undefined ? num(formatEther(perPayWei)) : undefined

  const usd = Number(avaxUsd)
  const costNum = perPayWei !== undefined ? Number(formatEther(perPayWei)) : undefined
  const gasUsd = costNum !== undefined && Number.isFinite(usd) ? costNum * usd : undefined
  const ratio = gasUsd !== undefined ? gasUsd / DEMO_PRICE : undefined
  const hasVerdict = ratio !== undefined && Number.isFinite(ratio)

  return (
    <div className="space-y-5">
      {/* 计费口径 —— 先选口径再看数,避免拿错基准得出好看但假的结论 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={LABEL}>计费口径</span>
        <div className="flex rounded-lg border border-line bg-ink p-0.5">
          <ModeButton active={!viaWallet} onClick={() => setViaWallet(false)}>
            节点建议价
          </ModeButton>
          <ModeButton active={viaWallet} onClick={() => setViaWallet(true)}>
            钱包默认小费
          </ModeButton>
        </div>
        <span className={LABEL}>
          {suggested === undefined ? '' : `节点此刻报 ${num(formatGwei(suggested))} nAVAX`}
        </span>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <div className="min-w-0">
          <div className={LABEL}>gasPrice(实付口径)</div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className={VALUE}>{isLoading ? '—' : (gasLabel ?? '—')}</span>
            <span className="shrink-0 text-xs text-muted">nAVAX</span>
          </div>
          <p className={`mt-1.5 leading-relaxed ${LABEL}`}>
            {viaWallet ? '钱包点确认实际付的价' : '节点建议价 —— 演示用不到'}
          </p>
        </div>

        <div className="min-w-0">
          <div className={LABEL}>一笔 3 方 pay()</div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className={VALUE}>{costLabel ?? '—'}</span>
            <span className="shrink-0 text-xs text-muted">AVAX</span>
          </div>
          <p className={`mt-1.5 leading-relaxed ${LABEL}`}>
            ≈{ESTIMATED_PAY_GAS.toLocaleString()} gas · W2 实测替换
          </p>
        </div>

        <div className="min-w-0">
          <div className={LABEL}>定价门槛</div>
          <label className="mt-1.5 flex items-center gap-2" htmlFor="avax-usd">
            <span className="shrink-0 text-[11px] text-muted">AVAX $</span>
            <input
              id="avax-usd"
              value={avaxUsd}
              onChange={(e) => setAvaxUsd(e.target.value)}
              inputMode="decimal"
              className="tnum w-full min-w-0 rounded-lg border border-line bg-ink px-2.5 py-1 font-mono text-sm text-neutral-100 outline-none transition focus:border-accent"
            />
          </label>
          <p className="mt-1.5 text-[11px] leading-relaxed">
            {!hasVerdict ? (
              <span className="text-muted">填市价即可结算</span>
            ) : ratio! <= 0.1 ? (
              <>
                <span className="text-emerald-400">✅ 过关</span>
                <span className="text-muted"> · 占 ${DEMO_PRICE} 的 {pct(ratio!)}</span>
              </>
            ) : (
              <>
                <span className="text-accent-soft">⚠️ 不过关</span>
                <span className="text-muted"> · 占 {pct(ratio!)},门槛 ≤10%</span>
              </>
            )}
          </p>
        </div>
      </div>

      {error && (
        <p className="text-xs leading-relaxed text-accent-soft">
          读链失败:{error.message.split('\n')[0]}
        </p>
      )}

      <p className="border-t border-line-soft pt-4 text-[11px] leading-relaxed text-muted">
        ⚠️ {ESTIMATED_PAY_GAS.toLocaleString()} gas 是
        <span className="text-neutral-300">抽样上界</span>,不是实测;W2 部署后
        必须用 <code className="text-neutral-400">forge script</code> 实测替换,并填进方案
        §12.2 的表格。链:{CHAIN.name} · {CHAIN.id}
      </p>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'rounded-md bg-white/[0.09] px-2.5 py-1 text-[11px] text-neutral-100'
          : 'rounded-md px-2.5 py-1 text-[11px] text-muted transition hover:text-neutral-300'
      }
    >
      {children}
    </button>
  )
}
