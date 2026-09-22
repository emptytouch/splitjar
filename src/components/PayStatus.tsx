import type { Hex } from 'viem'
import { UnlockButton } from './UnlockButton'
import {
  describeBlock,
  describeFailure,
  pendingCopy,
  stepCopy,
  type Description,
  type PayState,
  type Recovery,
} from '../lib/payMachine'
import { AVAX_FAUCET, USDC_FAUCET, explorerTx, shortHash } from '../lib/links'

/**
 * 状态机 → 界面。
 *
 * 这个组件**不做判断**:该显示什么、能不能重试,全由 `payMachine` 的
 * `describeBlock` / `describeFailure` 给出(那是逻辑,写错会让人重复支付,
 * 所以放在纯模块里可测)。这里只负责把结果画出来。
 *
 * ⚠️ 全组件唯一的硬要求来自方案 §14.2:「RPC 超时……**不得显示成功**」。
 * 所以成功态只从 `state.k === 'success'` 来 —— 没有任何一条
 * "看起来差不多就当成成功"的旁路。
 */

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
      role="status"
      aria-label="处理中"
    />
  )
}

/** 外链一律 `rel="noreferrer"` + 新窗口 —— 付费页是买家唯一停留的页面,别把它顶掉 */
function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-line underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  )
}

function TxLink({ hash }: { hash: Hex }) {
  return (
    <Ext href={explorerTx(hash)}>
      <span className="font-mono tnum">{shortHash(hash)}</span>
    </Ext>
  )
}

/** 把所有"出路"渲染成按钮/链接。`Recovery` 是判别联合,加新类型编译器会提醒 */
function RecoveryRow({
  recovery,
  contentId,
  filenameBase,
}: {
  recovery: Recovery
  contentId: Hex
  /** 下载下来那个文件叫什么(不含扩展名)。见 `UnlockButton` 的 props */
  filenameBase?: string
}) {
  switch (recovery.k) {
    case 'retry':
      // **这里故意不渲染按钮。**
      //
      // 「重新开始」的控件归付费页那个主按钮所有 —— 如果这里再放一个,
      // 就会出现两个重试入口;而像 `insufficient-usdc` 这种失败,
      // 出路是"去领币"而不是"重试",只在那两处放按钮会让用户
      // 领完币回来发现**没有任何按钮可以点**。
      // 主按钮常驻("重新检查")就不会有这个死角。
      return null

    case 'faucet':
      return (
        <a
          href={recovery.what === 'usdc' ? USDC_FAUCET : AVAX_FAUCET}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent hover:text-neutral-50"
        >
          去领测试 {recovery.what === 'usdc' ? 'USDC' : 'AVAX'}
        </a>
      )

    case 'explorer':
      return (
        <Ext href={explorerTx(recovery.hash)}>
          <span className="text-xs">在区块浏览器上查看</span>
        </Ext>
      )

    case 'download':
      // W5 兑现 —— 之前那句"下载功能在 W5 开放"的占位换成真的入口。
      // 这是**买家拿到东西的唯一途径**,所以它必须是主按钮,不是一行小字。
      return <div className="mt-1"><UnlockButton contentId={contentId} filenameBase={filenameBase} /></div>

    case 'none':
      return null

    default: {
      const never: never = recovery
      return never
    }
  }
}

const BOX = 'rounded-xl border px-4 py-3.5'

function Panel({
  tone,
  title,
  children,
}: {
  tone: 'work' | 'warn' | 'bad' | 'good'
  title: React.ReactNode
  children?: React.ReactNode
}) {
  const tones = {
    work: 'border-line bg-surface-2/60',
    warn: 'border-amber-400/30 bg-amber-400/[0.06]',
    bad: 'border-accent/35 bg-accent/[0.07]',
    good: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  } as const

  return (
    <div className={`${BOX} ${tones[tone]}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1">{title}</div>
      </div>
      {children && <div className="mt-2.5 pl-0">{children}</div>}
    </div>
  )
}

function Title({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-neutral-100">{children}</p>
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted">{children}</p>
}

export function PayStatus({
  state,
  needsApprove,
  contentId,
  filenameBase,
}: {
  state: PayState
  needsApprove: boolean
  /**
   * 解锁需要它 —— 但它**不在签名消息里由组件决定**,而是由
   * `useUnlockFlow` 组装时放进 EIP-712 消息(见 `shared/unlock.ts`)。
   * 这里传的只是"要解锁哪一份内容"。
   */
  contentId: Hex
  /**
   * 下载下来那个文件叫什么(**不含扩展名** —— 扩展名要等拿到响应才知道,
   * 由 `lib/download.ts` 按 `Content-Type` 定)。
   *
   * 一路从付费页串下来,因为标题是**付费页**从 `?t=` / 本地记忆里读出来的,
   * 这里不重复读一遍 —— 两处各读一次,迟早会有一处忘了归一化。
   * 缺省时 `UnlockButton` 退回用 contentId。
   */
  filenameBase?: string
}) {
  switch (state.k) {
    case 'idle':
      return null

    case 'checking':
      return (
        <Panel tone="work" title={<div className="flex items-center gap-2.5"><Spinner /><Title>正在检查…</Title></div>}>
          <Hint>核对内容、你的 USDC 余额和 gas。</Hint>
        </Panel>
      )

    case 'signing': {
      const copy = stepCopy(state.step, needsApprove)
      return (
        <Panel
          tone="work"
          title={
            <div className="flex items-center gap-2.5">
              <Spinner />
              <Title>请在钱包里确认</Title>
            </div>
          }
        >
          <Hint>
            <span className="text-neutral-300">{copy.label}</span>
            <br />
            {copy.hint}
          </Hint>
        </Panel>
      )
    }

    case 'pending': {
      const copy = pendingCopy(state.step, needsApprove)
      return (
        <Panel
          tone="work"
          title={
            <div className="flex items-center gap-2.5">
              <Spinner />
              <Title>{copy.title}</Title>
            </div>
          }
        >
          <Hint>
            交易 <TxLink hash={state.hash} /> · {copy.hint}
          </Hint>
        </Panel>
      )
    }

    case 'confirming':
      return (
        <Panel
          tone="work"
          title={
            <div className="flex items-center gap-2.5">
              <Spinner />
              <Title>正在向链上确认</Title>
            </div>
          }
        >
          <Hint>
            交易 <TxLink hash={state.hash} /> 已上链,正在核对购买记录。
          </Hint>
        </Panel>
      )

    case 'success':
      // 唯一能产生这个状态的路径是 reducer 的 `confirmed` —— 而它只在
      // 回链上读到 purchases == true 之后才被派发。没有任何"看起来像成功"的旁路。
      //
      // ⚠️ 「内容已解锁」这句只有在**下面真给出了下载入口**之后才成立。
      // 所以在 W5 之前这句话是虚的 —— 现在它兑现了。
      return (
        <Panel
          tone="good"
          title={
            <div className="flex items-center gap-2.5">
              <span className="text-emerald-400">✓</span>
              <Title>支付成功,内容已解锁</Title>
            </div>
          }
        >
          <Hint>
            交易 <TxLink hash={state.hash} /> · 钱已按预设比例直达各收款方钱包。
          </Hint>
          <div className="mt-3.5">
            <UnlockButton contentId={contentId} filenameBase={filenameBase} />
          </div>
        </Panel>
      )

    case 'blocked': {
      const d: Description = describeBlock(state.reason)
      return (
        <Panel tone="warn" title={<Title>{d.title}</Title>}>
          {d.hint && <Hint>{d.hint}</Hint>}
          <div className="mt-3">
            <RecoveryRow recovery={d.recovery} contentId={contentId} filenameBase={filenameBase} />
          </div>
        </Panel>
      )
    }

    case 'failed': {
      const d = describeFailure(state.reason, state.hash)
      return (
        <Panel tone="bad" title={<Title>{d.title}</Title>}>
          {d.hint && <Hint>{d.hint}</Hint>}
          {/* 技术细节只作为附加说明,没有它界面也完整 */}
          {state.detail && (
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted/70 break-all">
              {state.detail}
            </p>
          )}
          <div className="mt-3">
            <RecoveryRow recovery={d.recovery} contentId={contentId} filenameBase={filenameBase} />
          </div>
        </Panel>
      )
    }

    default: {
      const never: never = state
      return never
    }
  }
}
