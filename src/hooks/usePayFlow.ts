import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { erc20Abi, type Hex } from 'viem'
import {
  useAccount,
  useBalance,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { USDC } from '../../shared/chain'
import { INITIAL, payReducer, type PayState, type Step } from '../lib/payMachine'
import { evaluateGate, type GateInput } from '../lib/payGate'
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
 * ## ⚠️ 校验跑在**两个时刻**,但只有**一份判断**(2026-09-23)
 *
 * 判断本身在 `lib/payGate.ts` 的 `evaluateGate()`,这里只负责喂数据。
 *
 * - **首屏**:`state.k === 'idle'`。渲染时算一次,拦下的问题**直接显示**,
 *   用户不用点任何东西就知道"你早买过了"。
 * - **点击后**:`state.k === 'checking'`,校验 effect 再算一次,**作为权威**。
 *
 * 以前只有后者,于是首屏永远是"付款"按钮 —— 已经买过的人看到的是
 * 一个他点了才会被拒绝的按钮。见 `payGate.ts` 文件头。
 *
 * 两次算的是**同一个函数**,所以不会出现"首屏说能买、点下去说不能"。
 *
 * ## ⚠️ StrictMode 会把这些 effect 跑两遍
 *
 * `main.tsx` 里套了 `<StrictMode>`(开发模式故意双跑以暴露副作用问题)。
 * 如果不管,用户点一次付款会**弹两次钱包**。所以所有"只该发生一次"的动作
 * 都用一个 `fired` 集合去重 —— 见下面三个 effect 的 `fired.current.has(key)`。
 */

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

  // ① 闸门 ────────────────────────────────────────────────────────────
  //
  // 一个对象,两个消费者:渲染时算一次(首屏),点击后 effect 再算一次(权威)。
  // 判断逻辑全在 `evaluateGate`,这里只是把 wagmi 的读**翻译成它的入参**。
  const gateInput = useMemo<GateInput>(() => {
    // 任一读还在 loading 就先不下结论 —— 半套数据做出的判断会误报
    // "内容不存在""你已经买过"这类不可逆的错
    const reads = [exists, content, owned, usdcBalance, allowance] as const
    return {
      contentId,
      isConnected,
      address,
      chainId,
      readsSettled: !(reads.some((r) => r.isLoading) || avax.isLoading),
      exists: exists.data,
      existsError: exists.isError,
      contentError: content.isError,
      contentArrived: Boolean(contentData),
      active: contentData?.active,
      owned: owned.data,
      price: contentData?.price,
      usdc: usdcBalance.data,
      allowance: allowance.data,
      avaxWei: avax.data?.value,
    }
  }, [
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

  const gate = evaluateGate(gateInput)

  useEffect(() => {
    if (state.k !== 'checking') return

    // 数据还没齐 —— 留在 checking,下一轮渲染会再来一次
    if (gate.k === 'pending') return

    if (gate.k === 'blocked') return dispatch({ type: 'blocked', reason: gate.reason })

    // 授权额度够就跳过 approve —— 买过一次之后再买别的内容通常还能复用
    needsApprove.current = gate.needsApprove
    dispatch({ type: 'checked-ok', needsApprove: gate.needsApprove })
  }, [state, gate, gateInput])

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

  /**
   * 六个链上读的 `refetch`,攒成一个函数存进 ref。
   *
   * ⚠️ 为什么用 ref 而不是把六个 `.refetch` 塞进 `start` 的依赖:
   * `useReadContract` 返回的**对象身份每次渲染都变**,直接进依赖会让
   * `start` 每次渲染都是新函数 —— 而它会被当作 `onClick` 传下去、也可能
   * 被别处的 effect 依赖。ref 里换内容不影响 `start` 的身份。
   */
  const refetchAll = useRef<() => void>(() => {})
  useEffect(() => {
    refetchAll.current = () => {
      void exists.refetch()
      void content.refetch()
      void owned.refetch()
      void usdcBalance.refetch()
      void allowance.refetch()
      void avax.refetch()
    }
  })

  const start = useCallback(() => {
    // 重新开始前把去重表清空,否则重试时 sign:1 会被当成"已经发过"而静默不弹钱包
    fired.current = new Set()
    write.reset()

    // ⭐ **真的重新查一次链。**
    //
    // 2026-09-23 实测发现少了这一步,而按钮上写着「重新检查」:
    // 在下架状态下点它,**一个 RPC 请求都没发**(5 → 5),界面一字未变。
    // 它只把状态机 `dispatch` 成 `checking`,闸门拿到的是**同一份缓存**,
    // 于是原样又判回 `blocked` —— 一个点了没反应的死按钮。
    //
    // 后果最重的是**余额不足**:用户看到「USDC 不足」,去水龙头领了币,
    // 回来点「重新检查」—— 什么都不会发生。他只会以为这个页面坏了。
    // (下架那一态现在另有处理:出路是 `none`,按钮直接不渲染了 —— 见 PayPage。)
    refetchAll.current()

    dispatch({ type: 'start' })
  }, [write])

  const reset = useCallback(() => {
    fired.current = new Set()
    write.reset()
    dispatch({ type: 'reset' })
  }, [write])

  // 首屏:把闸门的结论**借给**渲染,但**不改状态机的状态**。
  //
  // 为什么不 dispatch 一个 blocked 就完事:那需要一条"什么时候能退回 idle"
  // 的规则 —— 用户换了钱包、切了网络、链上读刷新了,都得重新放行。状态机会
  // 变复杂,而且多出一类"卡在 blocked 出不来"的 bug。
  // 这里改成**派生态**:`idle` + 闸门说不行 = 显示不行。数据一变它就自己变,
  // 没有任何需要清理的东西。
  //
  // ⚠️ 两条**故意不透出去**:`wallet-not-connected` 和 `wrong-chain`。
  // 付费页自己就为这两条渲染了 `ConnectButton`,再透出去 `PayStatus`
  // 会多画一份「先连接钱包」的文案,和按钮叠在一起。
  // (本来也到不了这儿:没连接时页面不渲染付款按钮,`checking` 根本进不去。)
  const pageOwnsReason = gate.k === 'blocked' && (gate.reason === 'wallet-not-connected' || gate.reason === 'wrong-chain')
  const viewState: PayState =
    state.k === 'idle' && gate.k === 'blocked' && !pageOwnsReason
      ? { k: 'blocked', reason: gate.reason }
      : state

  return {
    state: viewState,
    needsApprove: needsApprove.current,
    content: contentData,
    // ⚠️ 这里**故意不看闸门**。`isReading` 为 false 且 `content` 为空时,
    // 付费页会渲染「内容不存在」—— 但对一个还没连钱包的人,`content` 那次读
    // 压根没启用(`enabled: exists.data === true` 还要等人连上),于是他会看到
    // 一个"内容不存在"的死结论。骨架屏更诚实:我们确实还不知道。
    isReading: enabled && (exists.isLoading || content.isLoading),
    pay: start,
    retry: start,
    reset,
  }
}

/** 供付费页显示的"这次大概要签几笔" */
export const STEP_LABEL: Record<Step, string> = { 1: 'approve', 2: 'pay' }
