import { useReducer } from 'react'
import type { Hex } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { CHAIN } from '../../shared/chain'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { formatUsdc } from '../lib/units'
import { AVAX_FAUCET, explorerTx } from '../lib/links'
import { shortReason } from '../lib/payErrors'
import { Panel, Spinner, TxLink } from './TxPanel'
import {
  INITIAL_CLAIM,
  claimReducer,
  classifyClaimError,
  describeClaimFailure,
  isClaimBusy,
  isDeadEnd,
  isTokenSide,
  type ClaimRecovery,
  type ClaimState,
} from '../lib/claimMachine'

/**
 * 「待提取」卡片 —— `withdraw()` 的界面。
 *
 * ## 这个组件补的是方案里一个真实的洞
 *
 * W4 计划 §5.3 的原话:「**通知这件事:escrow 目前没有收件人**」。
 * 合约把推送失败的那份记进 `pendingBalance[收款人]`,但**收款人没有身份、
 * 没有渠道知道这件事**:合约不知道他的邮箱,我们也没有他的联系方式。
 * 唯一的入口就是这里 —— 他连上钱包,看到这个数字,自己点走。
 *
 * 所以这张卡片不是"锦上添花的看板",**它是 escrow 这条路径能被走通的唯一出口**。
 * §5.4 记了当时把这条从"顺延"改成"W4 必做"的理由:
 * 「**一个没人取得出来的 escrow 不算'安全落地'**」——
 * Forge 能证明 `withdraw()` 不炸,但没有任何用户能碰到它。
 *
 * ## 谁能看到这个数字
 *
 * `pendingBalance[msg.sender]`,**按当前连上的钱包查**。所以:
 *  - 创作者连上 → 看自己推送失败的那份;
 *  - **协作者连上 → 看他自己那份**。这时上面「累计收入」是 0
 *    (他没创建过内容),但这里不是 0 —— 这两个数字看着矛盾,
 *    其实是同一件事的两面。别把它当成 bug"修"掉。
 */
export function ClaimPending({
  amount,
  onClaimed,
}: {
  amount: bigint
  /** 领取成功(或退款回滚后余额仍需重读)时调用 —— 由调用方重读 `pendingBalance` */
  onClaimed: () => void
}) {
  const { address, isConnected, chainId } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [state, dispatch] = useReducer(claimReducer, INITIAL_CLAIM)

  const onFuji = isConnected && chainId === CHAIN.id
  const busy = isClaimBusy(state)

  async function claim() {
    if (!address || !publicClient || !onFuji) return

    dispatch({ type: 'check' })

    // ⭐ **先预演,再发交易。**
    //
    // 不预演的话,被拉黑的用户点「领取」会走到 `eth_sendTransaction` ——
    // 钱包弹出来、用户签了、gas 付了,然后交易 revert。2026-09-22 在 fork
    // 上实测到的正是这一步:mock 钱包因为自己会估 gas 而拒绝了签名
    // (nonce 没变,没白花钱),但**换成不预估 gas 的钱包就会真发出去**。
    //
    // 预演一次就不会有这个形态:gas 估算阶段就 revert,一分钱不花、
    // 一个弹窗不弹,而且 revert 能被 viem 正经解出来(`revertText` 依赖它)。
    // 这也是 viem 官方推荐的 `simulate → write` 顺序。
    try {
      await publicClient.simulateContract({
        abi: creatorSplitterAbi,
        address: SPLITTER_ADDRESS,
        functionName: 'withdraw',
        account: address,
      })
    } catch (err) {
      dispatch({ type: 'fail', reason: classifyClaimError(err), detail: shortReason(err) })
      return
    }

    dispatch({ type: 'sign' })

    let hash: Hex
    try {
      hash = await writeContractAsync({
        abi: creatorSplitterAbi,
        address: SPLITTER_ADDRESS,
        functionName: 'withdraw',
      })
    } catch (err) {
      // 签名阶段就被拒 / 没签成 —— 一分钱没动
      dispatch({ type: 'fail', reason: classifyClaimError(err), detail: shortReason(err) })
      return
    }

    dispatch({ type: 'sent', hash })

    try {
      await publicClient.waitForTransactionReceipt({ hash })
    } catch (err) {
      // ⚠️ 这里**不等于**失败:`withdraw()` 是"先清零再转账",回滚会把清零一起撤掉,
      //    所以拿不到回执时钱仍在合约里,重试不会丢也不会重复领。
      //    文案见 `describeClaimFailure('receipt-timeout')` —— 不给一键重试。
      dispatch({ type: 'fail', reason: classifyClaimError(err), detail: shortReason(err) })
      return
    }

    dispatch({ type: 'done', hash })
    onClaimed()
  }

  // ── 数字 + 说明 ────────────────────────────────────────────
  const body = (
    <>
      <p className="font-mono tnum text-2xl font-semibold">
        {formatUsdc(amount)}
        <span className="ml-1.5 text-xs font-normal text-muted">USDC</span>
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        {amount > 0n
          ? '推送失败的份额暂存在合约里,只有你能取'
          : '没有推送失败的份额'}
      </p>
    </>
  )

  // 金额为 0 时**只有一个数字,没有任何可点的东西** —— 这是 §7.3 的第一条断言
  if (amount === 0n && state.k !== 'done') return body

  // ── 按钮 ───────────────────────────────────────────────────
  //
  // 按钮**永远在**(金额为 0 的那条早退除外),变的是它叫什么、点了做什么:
  //   - 被代币侧拦住(`token-*`)→ 「重新检查」,只重读余额,不重发交易;
  //   - 其它失败 → 「重试领取」;
  //   - 正常 → 「领取」。
  // 判据在 `claimMachine.isDeadEnd` 里(那是个会写错的判断:写错就是让用户
  // 无限重试一件做不到的事),组件只负责画 —— 同 PayStatus 的分工。
  const deadEnd = state.k === 'failed' && isDeadEnd(state.reason)

  /**
   * 死路上的唯一动作:重读一次余额。
   *
   * ⚠️ 这里**不是"重试"** —— 重发同一笔交易毫无意义,所以按钮上也不写"重试"。
   * 它做的是"再看看":Circle 可能刚解封、USDC 可能刚恢复,那时按钮会自己
   * 变回「领取」。
   *
   * 为什么死路上也非要留一个按钮:`PayStatus` 里踩过同一个坑 ——
   * 「只在那两处放按钮会让用户领完币回来发现**没有任何按钮可以点**」。
   * 一直转圈和彻底没按钮之间,要留一条能自己走出去的路。
   */
  function recheck() {
    dispatch({ type: 'reset' })
    onClaimed()
  }

  const label = busy
    ? state.k === 'checking'
      ? '正在核对…'
      : state.k === 'signing'
        ? '请在钱包里确认…'
        : '上链中…'
    : deadEnd
      ? '重新检查'
      : state.k === 'failed'
        ? '重试领取'
        : state.k === 'done'
          ? '已领取'
          : '领取'

  const btn = (
    <button
      type="button"
      onClick={() => void (deadEnd ? recheck() : claim())}
      disabled={busy || !onFuji || state.k === 'done'}
      className="mt-3 w-full rounded-xl border border-line bg-surface-2 px-4 py-2.5 text-sm text-neutral-100 transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  )

  return (
    <>
      {body}
      {!onFuji ? (
        <Panel tone="warn">
          <p className="text-xs leading-relaxed text-muted">
            钱包当前不在 {CHAIN.name}。取款是链上交易,要先切到 Fuji ——
            右上角连接钱包那里可以切。
          </p>
        </Panel>
      ) : (
        btn
      )}

      <ClaimPanel state={state} />
    </>
  )
}

/** 和 `PayStatus` 的 `RecoveryRow` 同理:`retry` 不渲染按钮,主按钮就是重试 */
function RecoveryRow({ recovery }: { recovery: ClaimRecovery }) {
  switch (recovery.k) {
    case 'retry':
    case 'wait': // 出路是等对方解封 —— 连按钮都不该有
    case 'none':
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

function ClaimPanel({ state }: { state: ClaimState }) {
  switch (state.k) {
    case 'idle':
      return null

    case 'checking':
      // 说明"还没碰你的钱包" —— 否则用户会盯着屏幕等弹窗
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            正在核对这笔钱能不能取
          </span>
          <p className="mt-1.5 text-xs text-muted">这一步不会唤起钱包,也不会花钱。</p>
        </Panel>
      )

    case 'signing':
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            请在钱包里确认取款
          </span>
        </Panel>
      )

    case 'pending':
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            正在上链
          </span>
          <p className="mt-1.5 text-xs text-muted">
            交易 <TxLink hash={state.hash} /> · 等回执,别关页面
          </p>
        </Panel>
      )

    case 'done':
      return (
        <Panel tone="good">
          <span className="text-emerald-400">✓</span> 已领取 —— USDC 已进你的钱包
          <p className="mt-1.5 text-xs text-muted">
            交易 <TxLink hash={state.hash} /> · 上面的数字会刷成 0
          </p>
        </Panel>
      )

    case 'failed': {
      const d = describeClaimFailure(state.reason, state.hash)
      return (
        <Panel tone={isTokenSide(state.reason) ? 'warn' : 'bad'}>
          {d.title}
          {d.hint && <p className="mt-1.5 text-xs text-muted">{d.hint}</p>}
          {state.detail && (
            <p className="mt-2 font-mono text-[11px] break-all text-muted/70">{state.detail}</p>
          )}
          <RecoveryRow recovery={d.recovery} />
        </Panel>
      )
    }

    default: {
      const never: never = state
      return never
    }
  }
}
