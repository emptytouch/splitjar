import { useState } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { CHAIN } from '../../shared/chain'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const itemCls =
  'w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-200 transition hover:bg-white/[0.06] disabled:opacity-50'

/**
 * `nav` —— 顶栏里的紧凑胶囊 + 下拉面板(桌面主场景)
 * `block` —— 整行按钮(窄屏或空状态卡片里用)
 */
export function ConnectButton({ variant = 'nav' }: { variant?: 'nav' | 'block' }) {
  const [open, setOpen] = useState(false)
  const { address, isConnected, chainId } = useAccount()
  const { connectors, connect, isPending, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: isSwitching } = useSwitchChain()

  const wrongChain = isConnected && chainId !== CHAIN.id
  const firstError = error?.message.split('\n')[0]

  if (variant === 'block') {
    return (
      <div className="space-y-2">
        {connectors.length === 0 && (
          <p className="text-xs leading-relaxed text-muted">
            没检测到浏览器钱包。装一个 Core Wallet 扩展,或等 WalletConnect 配好后再来。
          </p>
        )}
        {connectors.map((c) => (
          <button
            key={c.uid}
            onClick={() => connect({ connector: c })}
            disabled={isPending}
            className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {isPending ? '连接中…' : `连接 ${c.name}`}
          </button>
        ))}
        {firstError && <p className="text-xs leading-relaxed text-accent-soft">{firstError}</p>}
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm transition ${
          isConnected
            ? 'border-line bg-surface text-neutral-100 hover:border-line/80 hover:bg-surface-2'
            : 'border-transparent bg-accent text-white hover:brightness-110'
        }`}
      >
        {isConnected ? (
          <>
            <span
              className={`h-1.5 w-1.5 rounded-full ${wrongChain ? 'bg-amber-400' : 'bg-emerald-400'}`}
            />
            <code className="font-mono text-[13px]">{short(address!)}</code>
          </>
        ) : (
          '连接钱包'
        )}
      </button>

      {open && (
        <>
          {/* 点任意处关闭 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute right-0 top-full z-50 mt-2 w-[17rem] rounded-xl border border-line bg-surface p-2 shadow-2xl shadow-black/60">
            {!isConnected ? (
              <>
                <p className="px-3 py-2 text-[11px] text-muted">选择钱包</p>
                {connectors.length === 0 && (
                  <p className="px-3 pb-2 text-xs leading-relaxed text-muted">
                    没检测到浏览器钱包扩展。
                  </p>
                )}
                {connectors.map((c) => (
                  <button
                    key={c.uid}
                    onClick={() => {
                      connect({ connector: c })
                      setOpen(false)
                    }}
                    disabled={isPending}
                    className={itemCls}
                  >
                    {c.name}
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[11px] text-muted">已连接</span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
                    {wrongChain ? `链 ${chainId}` : CHAIN.name}
                  </span>
                </div>
                <div className="px-3 pb-3">
                  <code className="font-mono text-xs break-all text-neutral-300">{address}</code>
                </div>

                {wrongChain && (
                  <button
                    onClick={() => {
                      switchChain({ chainId: CHAIN.id })
                      setOpen(false)
                    }}
                    disabled={isSwitching}
                    className="mb-1 w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                  >
                    {isSwitching ? '切换中…' : `切换到 ${CHAIN.name}`}
                  </button>
                )}

                <button
                  onClick={() => {
                    disconnect()
                    setOpen(false)
                  }}
                  className={itemCls}
                >
                  断开连接
                </button>
              </>
            )}

            {firstError && (
              <p className="px-3 pt-2 text-xs leading-relaxed text-accent-soft">{firstError}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
