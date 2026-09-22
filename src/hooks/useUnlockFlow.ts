import { useCallback, useReducer, useRef } from 'react'
import type { Address, Hex } from 'viem'
import { useAccount, useSignTypedData } from 'wagmi'
import { CHAIN } from '../../shared/chain'
import type { UnlockMessage } from '../../shared/unlock'
import { fromUnlockMessage, nextUnlockDeadline, unlockTypedData } from '../../shared/unlock'
import { isUserRejection } from '../lib/payErrors'
import { SPLITTER_ADDRESS } from '../lib/splitter'
import { classifyUnlockError, fetchUnlockNonce, postUnlock } from '../lib/unlockApi'
import { UNLOCK_INITIAL, unlockReducer, type UnlockState } from '../lib/unlockMachine'

/**
 * 把 `unlockMachine`(纯逻辑)接到 wagmi 的 `signTypedData` 和两个路由上。
 *
 * ## 与 `usePayFlow` 最大的不同:这里**没有 effect**
 *
 * 付款那边必须用 effect,因为每一步都要停下来等**外部事件**
 * (钱包弹窗、交易收据、链上确认),而那些事件是 wagmi 用 hook 状态推过来的。
 *
 * 解锁不一样:它是一串 `await`,从头到尾由**一次点击**驱动。所以整条流程就是
 * 一个 `async` 函数,状态机只负责让界面在中途有东西可显示。
 * 顺带绕开了 `usePayFlow` 里那个 `fired` 去重集合 —— StrictMode 不会
 * 把一次点击跑两遍。(⚠️ 但**连点两下**会,所以下面有个 `running` ref。)
 *
 * ## 每一次尝试都重新取 nonce
 *
 * 服务端在签发下载 URL 的最后一步把 nonce 删掉(`api/unlock.ts` 的第 ⑥ 步),
 * 所以失败后**不能复用**上一次的 nonce —— 那个已经被用掉了。
 * 这也是为什么 `unlock()` 一律从"取 nonce"开始,而不是从"签名"开始。
 */

export type UnlockFlow = {
  state: UnlockState
  /** 开始(或重试)。失败后调它就是重试 —— 会重新取 nonce */
  unlock: () => void
  reset: () => void
  /** 现在能不能发起解锁。不能的话界面该显示别的东西(连接钱包 / 切网络) */
  canStart: boolean
}

export function useUnlockFlow(contentId: Hex | null): UnlockFlow {
  const { address, isConnected, chainId } = useAccount()
  const [state, dispatch] = useReducer(unlockReducer, UNLOCK_INITIAL)
  const { signTypedDataAsync } = useSignTypedData()

  /**
   * 防连点。
   *
   * 状态机在**下一次渲染之后**才会让按钮 `disabled`,而两次点击可以落在
   * 同一次渲染之前 —— 那样会跑两条流程、签两次名、要两个 nonce。
   * 第二次那个反而会把第一次的 nonce 撞掉(服务端的 `consumeNonce` 只认先到的)。
   */
  const running = useRef(false)

  const canStart = Boolean(contentId) && isConnected && chainId === CHAIN.id

  const unlock = useCallback(() => {
    if (running.current) return
    if (!contentId) return
    if (!isConnected || !address) {
      dispatch({ type: 'fail', reason: 'not-connected' })
      return
    }
    if (chainId !== CHAIN.id) {
      dispatch({ type: 'fail', reason: 'wrong-chain' })
      return
    }

    running.current = true
    dispatch({ type: 'start' })

    void (async () => {
      try {
        // ① 一次性 nonce。服务端把它绑到这个 contentId 上
        const nonce = await fetchUnlockNonce(contentId)
        dispatch({ type: 'step', step: 'sign' })

        // ② 组装签名消息。deadline 在这里现算 —— **越接近签名时刻越好**,
        //    提前算好会让"用户犹豫了一会儿"吃掉有效期
        const message: UnlockMessage = {
          contentId,
          buyer: address as Address,
          nonce: BigInt(nonce),
          deadline: nextUnlockDeadline(),
        }

        // ⚠️ 必须显式传 `SPLITTER_ADDRESS`(会读 `VITE_SPLITTER_ADDRESS`)。
        // 不传的话会落到 `shared/eip712.ts` 的默认值 `DEPLOYED_SPLITTER`,
        // 而服务端读的是 `serverEnv('SPLITTER_ADDRESS')` —— 两边一旦有一个
        // 被环境变量覆盖,domain 就分叉,症状是**签名永远验不过**
        // 且报错看不出哪里错了。这正是 `shared/eip712.ts` 头部警告的那件事。
        const signature = await signTypedDataAsync(unlockTypedData(message, SPLITTER_ADDRESS))
        dispatch({ type: 'step', step: 'unlock' })

        // ③ 换下载链接。`fromUnlockMessage` 与签名侧共用同一个转换 ——
        //    bigint 不能进 JSON,所以这里显式转成十进制字符串
        const { url, expiresInSeconds } = await postUnlock(fromUnlockMessage(message, signature as Hex))

        // 绝对时刻,不是剩余秒数 —— 理由见 `unlockMachine` 的 `UnlockState`
        dispatch({ type: 'ready', url, expiresAt: Date.now() + expiresInSeconds * 1000 })
      } catch (e) {
        const err = classifyUnlockError(e, isUserRejection)
        dispatch({ type: 'fail', reason: err.reason, detail: err.detail })
      } finally {
        running.current = false
      }
    })()
  }, [contentId, isConnected, address, chainId, signTypedDataAsync])

  const reset = useCallback(() => {
    running.current = false
    dispatch({ type: 'reset' })
  }, [])

  return { state, unlock, reset, canStart }
}
