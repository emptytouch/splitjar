import { useReducer } from 'react'
import type { Hex } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { CHAIN } from '../../shared/chain'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { AVAX_FAUCET, explorerTx } from '../lib/links'
import { shortReason } from '../lib/payErrors'
import { Panel, Spinner, TxLink } from './TxPanel'
import {
  INITIAL_ACTIVE,
  activeBusyLabel,
  activeReducer,
  classifyActiveError,
  describeActiveFailure,
  describeActiveSuccess,
  isActiveBusy,
  isActiveDeadEnd,
  type ActiveRecovery,
  type ActiveState,
} from '../lib/activeMachine'

/**
 * 「上架 / 下架」开关 —— `setContentActive()` 的界面。
 *
 * ## 这个组件补的是一个**能力**缺口,不是 UI 缺口
 *
 * 方案 §5.1 要求「创作者可 `setContentActive(contentId, false)`」。
 * 合约实现了好几个月、ABI 也早就在仓库里 —— 但**全仓库零调用点**。
 * 后果:一件内容一旦创建就**永远无法下架**,而方案 §14.2 那张异常状态表
 * 里的「已下架 → 显示"已下架",不显示支付按钮」**没有任何真实路径能走到**。
 *
 * 所以这个开关不是"加个按钮",它是**把一条已经写在合约里的产品能力接上**。
 *
 * ## ⭐ 那句必须让用户先看到的话
 *
 * **下架 ≠ 收回。** 下架只拦新买家(合约 `pay()` revert `ContentInactive`),
 * **已经付过钱的人照常下载** —— 服务端门禁只看 `hasPurchased`,从不看 `active`。
 *
 * 创作者按这个按钮时最怕的就是"我会不会把已经买了的人一起坑了"。
 * 所以那句话写在**按钮旁边的行内提示里**(见 `DashboardPage` 的
 * `REASSURANCE`),不藏在文档里 —— 他按下之前就得知道答案。
 *
 * ⚠️ 承诺这件事的**不只是文案**,还有 `payGate.ts` 里归属判断必须排在
 * 下架判断**之前**。两处是一件事的两半,改一处必须想到另一处。
 */
export function ActiveToggle({
  contentId,
  active,
  onChanged,
}: {
  contentId: Hex
  /** 链上当前状态(由 `useMyContents` 从事件推导) */
  active: boolean
  /** 改成功之后调用 —— 由调用方 refetch 那份内容列表 */
  onChanged: () => void
}) {
  const { address, isConnected, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [state, dispatch] = useReducer(activeReducer, INITIAL_ACTIVE)

  const onFuji = isConnected && chainId === CHAIN.id
  const busy = isActiveBusy(state)
  const target = !active

  async function apply() {
    if (!address || !publicClient || !onFuji) return

    dispatch({ type: 'check', target })

    // ⭐ **先预演,再发交易。** 理由同 `ClaimPending`:不预演的话,一笔注定
    // revert 的交易会走到 `eth_sendTransaction` —— 钱包弹出来、用户签了、
    // gas 付了,然后失败。预演则一分钱不花、一个弹窗不弹,而且 revert 能被
    // viem 正经解出来(`NotCreator` / `ContentNotFound` 靠它认)。
    // 这也是 viem 官方推荐的 `simulate → write` 顺序。
    try {
      await publicClient.simulateContract({
        abi: creatorSplitterAbi,
        address: SPLITTER_ADDRESS,
        functionName: 'setContentActive',
        args: [contentId, target],
        account: address,
      })
    } catch (err) {
      dispatch({ type: 'fail', reason: classifyActiveError(err), detail: shortReason(err) })
      return
    }

    dispatch({ type: 'sign' })

    let hash: Hex
    try {
      hash = await writeContractAsync({
        abi: creatorSplitterAbi,
        address: SPLITTER_ADDRESS,
        functionName: 'setContentActive',
        args: [contentId, target],
      })
    } catch (err) {
      // 签名阶段就被拒 / 没签成 —— 链上状态一个字节都没动
      dispatch({ type: 'fail', reason: classifyActiveError(err), detail: shortReason(err) })
      return
    }

    dispatch({ type: 'sent', hash })

    try {
      await publicClient.waitForTransactionReceipt({ hash })
    } catch (err) {
      // ⚠️ 这里**不等于**失败 —— 交易可能已经上链,只是回执没等到。
      //    文案见 `describeActiveFailure('receipt-timeout')`:不给一键重试,
      //    只给去区块浏览器核对。
      dispatch({ type: 'fail', reason: classifyActiveError(err), detail: shortReason(err) })
      return
    }

    dispatch({ type: 'done', hash })
    onChanged()
  }

  const deadEnd = state.k === 'failed' && isActiveDeadEnd(state.reason)

  /**
   * 死路上的动作:重读列表。
   *
   * ⚠️ **不是"重试"** —— 重发同一笔交易毫无意义(权限不对就是不对),
   * 所以按钮上也不写"重试"。它做的是"再看看":刷新之后如果那一行本来就
   * 该消失(链上没有这件内容),它会自己消失。
   */
  function recheck() {
    dispatch({ type: 'reset' })
    onChanged()
  }

  const label = busy
    ? activeBusyLabel(state)
    : deadEnd
      ? '刷新列表'
      : state.k === 'failed'
        ? '重试'
        : target
          ? '重新上架'
          : '下架'

  return (
    <>
      {/*
        ⚠️ 这一块必须是**全宽的自足块**(flex + w-full + 自己带 border-t),
        因为它要作为 `<li>` 的直接子元素摆放。**别把它塞进调用方的 flex 行里** ——
        那样下面的 `Panel`(状态说明)会变成同一行的第二个 flex item,
        被挤成窄窄一条,里面的解释文字会烂掉。
      */}
      <div className="mt-3 flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-soft pt-3">
        {/*
          ⚠️ 这句是**产品承诺,不是装饰**。只在内容**在售**时显示 ——
          那正是他准备按下"下架"、心里犯嘀咕的那一刻。
          已经下架了再重复一遍没有意义(他早知道了),而按钮那时写的是"重新上架"。
        */}
        <p className="min-w-0 text-[11px] leading-relaxed text-muted">
          {active ? '下架只拦新买家;已经付过钱的人仍可下载' : '这件内容已下架,不再接受新付款'}
        </p>

        <button
          type="button"
          onClick={() => void (deadEnd ? recheck() : apply())}
          disabled={busy || !onFuji}
          className={
            'shrink-0 rounded-lg border bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-200 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
            (target ? 'border-line hover:border-emerald-400/50' : 'border-line hover:border-amber-400/50')
          }
        >
          {label}
        </button>
      </div>

      {!onFuji ? (
        <Panel tone="warn">
          <p className="text-xs leading-relaxed text-muted">
            钱包当前不在 {CHAIN.name}。上下架是链上交易,要先切到 Fuji ——
            右上角连接钱包那里可以切。
          </p>
        </Panel>
      ) : null}

      <ActivePanel state={state} />
    </>
  )
}

function ActivePanel({ state }: { state: ActiveState }) {
  switch (state.k) {
    case 'idle':
      return null

    case 'checking':
      // 说明"还没碰你的钱包" —— 否则用户会盯着屏幕等弹窗
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            正在核对该不该改
          </span>
          <p className="mt-1.5 text-xs text-muted">这一步不会唤起钱包,也不会花钱。</p>
        </Panel>
      )

    case 'signing':
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            请在钱包里确认
          </span>
        </Panel>
      )

    case 'pending':
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            {state.target ? '正在上架' : '正在下架'}
          </span>
          <p className="mt-1.5 text-xs text-muted">
            交易 <TxLink hash={state.hash} /> · 等回执,别关页面
          </p>
        </Panel>
      )

    case 'done': {
      const d = describeActiveSuccess(state.target)
      return (
        <Panel tone="good">
          <span className="text-emerald-400">{d.title}</span>
          <p className="mt-1.5 text-xs text-muted">
            {d.hint} 交易 <TxLink hash={state.hash} />
          </p>
        </Panel>
      )
    }

    case 'failed': {
      const d = describeActiveFailure(state.reason, state.hash)
      return (
        <Panel tone="bad">
          {d.title}
          {d.hint && <p className="mt-1.5 text-xs text-muted">{d.hint}</p>}
          {state.detail && (
            <p className="mt-2 font-mono text-[11px] break-all text-muted/70">{state.detail}</p>
          )}
          <ActiveRecoveryRow recovery={d.recovery} />
        </Panel>
      )
    }

    default: {
      const never: never = state
      return never
    }
  }
}

/** 同 `ClaimPending.RecoveryRow` 的分工:状态机决定给什么,组件只负责画 */
function ActiveRecoveryRow({ recovery }: { recovery: ActiveRecovery }) {
  switch (recovery.k) {
    case 'retry':
    case 'none':
    case 'switch-wallet': // 出路是换个钱包,这个页面给不了 —— 文案里已经说了
      return null

    case 'faucet':
      return (
        <a
          href={AVAX_FAUCET}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent hover:text-neutral-50"
        >
          去领测试 AVAX
        </a>
      )

    case 'explorer':
      return (
        <p className="mt-2 text-xs">
          <a
            href={explorerTx(recovery.hash)}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-line underline-offset-2 hover:decoration-accent"
          >
            在区块浏览器上核对这笔交易
          </a>
        </p>
      )

    default: {
      const never: never = recovery
      return never
    }
  }
}
