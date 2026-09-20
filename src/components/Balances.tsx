import { erc20Abi, formatUnits } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { CHAIN, USDC } from '../../shared/chain'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

function Stat({
  label,
  value,
  unit,
  note,
  loading,
}: {
  label: string
  value?: string
  unit: string
  note: string
  loading: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="tnum truncate font-mono text-2xl font-medium text-neutral-50">
          {loading ? '—' : (value ?? '0')}
        </span>
        <span className="shrink-0 text-xs text-muted">{unit}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  )
}

/** 横条式余额栏 —— 铺满宽度,避免和右侧高卡片同行时被撑出空洞 */
export function Balances() {
  const { address, isConnected, chainId } = useAccount()
  const enabled = isConnected && Boolean(address)

  const native = useBalance({ address, query: { enabled } })

  // wagmi v3 的 useBalance 已不支持 `token` —— ERC-20 余额走 useReadContract
  const usdc = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled },
  })

  // 未连接时保持同样的四列骨架 —— 空版面比"少一行字"更好读,也避免卡片塌成一条
  if (!isConnected) {
    return (
      <div className="space-y-4">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="AVAX" value="—" unit="AVAX" note="付 gas —— 买家最容易缺的就是它(坑 3)" loading={false} />
          <Stat label="USDC" value="—" unit="USDC" note="付款 · faucet 限 1 USDC / 2 小时 / 地址" loading={false} />
          <Stat label="网络" value="—" unit="" note={`需要切到 ${CHAIN.name}`} loading={false} />
          <div className="min-w-0">
            <div className="text-[11px] text-muted">地址</div>
            <div className="mt-1.5">
              <code className="font-mono text-sm text-muted">未连接</code>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">点右上角「连接钱包」</p>
          </div>
        </div>
        <p className="border-t border-line-soft pt-4 text-[11px] leading-relaxed text-muted">
          测试币:AVAX 走 Core faucet(付 gas),USDC 走 Circle faucet(付款)。
          Circle 限 1 USDC / 2 小时 / 地址 —— 演示前要提前攒,见开发计划 W0。
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        label="AVAX"
        value={native.data ? formatUnits(native.data.value, native.data.decimals) : undefined}
        unit="AVAX"
        note="付 gas —— 买家最容易缺的就是它(坑 3)"
        loading={native.isLoading}
      />
      <Stat
        label="USDC"
        value={usdc.data !== undefined ? formatUnits(usdc.data, USDC.decimals) : undefined}
        unit="USDC"
        note="付款 · faucet 限 1 USDC / 2 小时 / 地址"
        loading={usdc.isLoading}
      />
      <Stat
        label="网络"
        value={chainId === CHAIN.id ? 'Fuji' : `链 ${chainId}`}
        unit=""
        note={chainId === CHAIN.id ? '已就位' : `需要切到 ${CHAIN.name}`}
        loading={false}
      />
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted">地址</div>
        <div className="mt-1.5">
          <code className="font-mono text-sm text-neutral-200">{short(address!)}</code>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">已连接钱包</p>
      </div>
    </div>
  )
}
