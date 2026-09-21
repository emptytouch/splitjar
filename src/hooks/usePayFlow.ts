import { useCallback, useEffect, useReducer, useRef } from 'react'
import { erc20Abi, type Hex } from 'viem'
import {
  useAccount,
  useBalance,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { CHAIN, ESTIMATED_PAY_GAS, USDC, WALLET_DEFAULT_TIP } from '../../shared/chain'
import { INITIAL, payReducer, type PayState, type Step } from '../lib/payMachine'
import { classifyError, shortReason } from '../lib/payErrors'
import { SPLITTER_ADDRESS, creatorSplitterAbi, toContent, type Content } from '../lib/splitter'

/**
 * 把 `payMachine`(纯逻辑)接到 wagmi(有副作用的读/写)上。
 *
 * ## 为什么接线要单独一个 hook,而不是写在付费页组件里
 *
 * 付费页组件只该关心"渲染成什么样"。而这里全是**有顺序的副作用**:
 * 校验 → 签第 1 笔 → 等收据 → 签第 2 笔 → 等收据 → 回链上坐实。
 * 混在 JSX 文件里,读代码的人要在 `useEffect` 和 `return (` 之间来回跳。
 *
 * ## ⚠️ StrictMode 会把这些 effect 跑两遍
 *
 * `main.tsx` 里套了 `<StrictMode>`(开发模式故意双跑以暴露副作用问题)。
 * 如果不管,用户点一次付款会**弹两次钱包**。所以所有"只该发生一次"的动作
 * 都用一个 `fired` 集合去重 —— 见下面三个 effect 的 `fired.current.has(key)`。
 */

/** AVAX 预检要留的余量 —— 比 `pay` 贵得多的是 approve + pay 两笔 */
function avaxNeeded(needsApprove: boolean): bigint {
  const txCount = needsApprove ? 2n : 1n
  // 按**钱包实付口径**算(1 nAVAX),不是节点建议价。
  // 节点报 160 wei,差 600 万倍 —— 用错口径算出来的"余额够"是假的。
  // 这正是 ChainProbe 当初踩过的坑,见 shared/chain.ts 的 WALLET_DEFAULT_TIP 注释。
  return ESTIMATED_PAY_GAS * txCount * WALLET_DEFAULT_TIP
}

export type PayFlow = {
  state: PayState
  /** 这一次需不需要先授权(决定显示"两笔"还是"一笔") */
  needsApprove: boolean
  /** 链上读到的内容。付费页要显示价格与分账比例,不用再读一遍 */
  content: Content | undefined
  /** 内容 / 已购状态是否还在读 —— 付费页据此显示骨架屏(§14.2:首屏不得白屏) */
  isReading: boolean
  pay: () => void
  retry: () => void
  reset: () => void
}

export function usePayFlow(contentId: Hex | null): PayFlow {
  const { address, isConnected, chainId } = useAccount()
  const [state, dispatch] = useReducer(payReducer, INITIAL)

  // 「已经发起过」的动作去重,防 StrictMode 双跑导致重复弹钱包
  const fired = useRef<Set<string>>(new Set())
  // 这次流程要不要授权。校验时定下,写进 ref 供文案与签名步骤共用
  const needsApprove = useRef(true)

  const enabled = Boolean(contentId)

  // ── 读链 ────────────────────────────────────────────────────────────
  const exists = useReadContract({
    abi: creatorSplitterAbi,
    address: SPLITTER_ADDRESS,
    functionName: 'contentExists',
    args: contentId ? [contentId] : undefined,
    query: { enabled },
  })

  const content = useReadContract({
    abi: creatorSplitterAbi,
    address: SPLITTER_ADDRESS,
    functionName: 'getContent',
    args: contentId ? [contentId] : undefined,
    // contentExists 为 false 时别去读 —— 那会 revert ContentNotFound,
    // 白白在控制台糊一堆错误
    query: { enabled: enabled && exists.data === true },
  })

  const owned = useReadContract({
    abi: creatorSplitterAbi,
    address: SPLITTER_ADDRESS,
    functionName: 'purchases',
    args: contentId && address ? [contentId, address] : undefined,
    query: { enabled: enabled && Boolean(address) },
  })

  const usdcBalance = useReadContract({
    abi: erc20Abi,
    address: USDC.address,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    // ⚠️ wagmi v3 的 useBalance **不支持 token 参数**了,ERC-20 只能这么读
    query: { enabled: Boolean(address) },
  })

  const allowance = useReadContract({
    abi: erc20Abi,
    address: USDC.address,
    functionName: 'allowance',
    args: address ? [address, SPLITTER_ADDRESS] : undefined,
    query: { enabled: Boolean(address) },
  })

  // AVAX 走 useBalance(原生币,没有 token 参数的问题)
  const avax = useBalance({ address, query: { enabled: Boolean(address) } })

  // ── 写链 ────────────────────────────────────────────────────────────
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })

  const contentData = content.data ? toContent(content.data) : undefined
  const price = contentData?.price

  // ① 校验 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'checking') return

    if (!contentId) return dispatch({ type: 'blocked', reason: 'content-not-found' })
    if (!isConnected || !address) return dispatch({ type: 'blocked', reason: 'wallet-not-connected' })
    if (chainId !== CHAIN.id) return dispatch({ type: 'blocked', reason: 'wrong-chain' })

    // 等所有读都有结果。任一还在 loading 就先不动 —— 半套数据做出的判断
    // 会误报"内容不存在"这类不可逆的错
    const reads = [exists, content, owned, usdcBalance, allowance] as const
    if (reads.some((r) => r.isLoading) || avax.isLoading) return

    if (exists.isError || exists.data !== true) {
      return dispatch({ type: 'blocked', reason: 'content-not-found' })
    }
    if (content.isError) return dispatch({ type: 'blocked', reason: 'content-not-found' })
    if (!contentData) return // 数据还没到,下一轮再说
    if (!contentData.active) return dispatch({ type: 'blocked', reason: 'content-inactive' })
    if (owned.data === true) return dispatch({ type: 'blocked', reason: 'already-purchased' })

    if ((usdcBalance.data ?? 0n) < contentData.price) {
      return dispatch({ type: 'blocked', reason: 'insufficient-usdc' })
    }

    // 授权额度够就跳过 approve —— 买过一次之后再买别的内容通常还能复用
    const needs = (allowance.data ?? 0n) < contentData.price
    needsApprove.current = needs

    if ((avax.data?.value ?? 0n) < avaxNeeded(needs)) {
      return dispatch({ type: 'blocked', reason: 'insufficient-avax' })
    }

    dispatch({ type: 'checked-ok', needsApprove: needs })
  }, [
    state,
    contentId,
    isConnected,
    address,
    chainId,
    exists,
    content,
    contentData,
    owned,
    usdcBalance,
    allowance,
    avax,
  ])

  // ② 唤起钱包签名 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'signing' || !contentId) return
    const key = `sign:${state.step}`
    if (fired.current.has(key)) return
    fired.current.add(key)

    if (state.step === 1 && price !== undefined) {
      write.writeContract({
        abi: erc20Abi,
        address: USDC.address,
        functionName: 'approve',
        args: [SPLITTER_ADDRESS, price],
      })
    } else {
      write.writeContract({
        abi: creatorSplitterAbi,
        address: SPLITTER_ADDRESS,
        functionName: 'pay',
        args: [contentId],
      })
    }
  }, [state, contentId, price, write])

  // ③ 拿到交易哈希 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'signing' || !write.data) return
    const key = `sent:${state.step}:${write.data}`
    if (fired.current.has(key)) return
    fired.current.add(key)
    dispatch({ type: 'sent', step: state.step, hash: write.data })
  }, [state, write.data])

  // ④ 收据回来 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'pending' || !write.data) return

    if (receipt.isSuccess) {
      // 第 1 笔好了**不停留** —— 中间态对用户没意义,只会让他以为流程走完了
      if (state.step === 1) dispatch({ type: 'approve-confirmed' })
      else dispatch({ type: 'pay-confirmed', hash: write.data })
      return
    }

    if (receipt.isError) {
      dispatch({
        type: 'fail',
        reason: classifyError(receipt.error, state.step),
        hash: write.data,
        detail: shortReason(receipt.error),
      })
    }
  }, [state, write.data, receipt.isSuccess, receipt.isError, receipt.error])

  // ⑤ 签名阶段就报错(还没拿到哈希) ─────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'signing' || !write.error) return
    dispatch({
      type: 'fail',
      reason: classifyError(write.error, state.step),
      detail: shortReason(write.error),
    })
  }, [state, write.error])

  // ⑥ 坐实:回链上确认购买标记真的置位了 ───────────────────────────────
  //
  // 「确认中」在这里才**有真实含义**:收据只证明交易成功了,
  // 而我们要的是 `purchases[contentId][buyer] == true`。
  // 把解锁建立在链上事实上,而不是建立在"回执说成功"上。
  //
  // 重试几次还不行就给 `receipt-timeout`(带 explorer 链接、**不给重试按钮**)——
  // 此时交易很可能已经成功,给重试会让用户重复支付。
  useEffect(() => {
    if (state.k !== 'confirming') return
    let cancelled = false

    const settle = async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        const r = await owned.refetch()
        if (cancelled) return
        if (r.data === true) return dispatch({ type: 'confirmed', hash: state.hash })
        if (r.error && i === 4) {
          return dispatch({
            type: 'fail',
            reason: 'receipt-timeout',
            hash: state.hash,
            detail: shortReason(r.error),
          })
        }
        await new Promise((res) => setTimeout(res, 1500))
      }
      // 五次都是 false:交易成功但标记没置位,这不该发生 ——
      // 不谎报成功,给用户 explorer 链接自己看
      if (!cancelled) {
        dispatch({ type: 'fail', reason: 'receipt-timeout', hash: state.hash })
      }
    }

    void settle()
    return () => {
      cancelled = true
    }
  }, [state, owned])

  // ── 对外的动作 ───────────────────────────────────────────────────────
  const start = useCallback(() => {
    // 重新开始前把去重表清空,否则重试时 sign:1 会被当成"已经发过"而静默不弹钱包
    fired.current = new Set()
    write.reset()
    dispatch({ type: 'start' })
  }, [write])

  const reset = useCallback(() => {
    fired.current = new Set()
    write.reset()
    dispatch({ type: 'reset' })
  }, [write])

  return {
    state,
    needsApprove: needsApprove.current,
    content: contentData,
    isReading: enabled && (exists.isLoading || content.isLoading),
    pay: start,
    retry: start,
    reset,
  }
}

/** 供付费页显示的"这次大概要签几笔" */
export const STEP_LABEL: Record<Step, string> = { 1: 'approve', 2: 'pay' }
