import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSignTypedData, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { uploadPathname } from '../../shared/storage'
import { isUserRejection, shortReason } from '../lib/payErrors'
import {
  PUBLISH_INITIAL,
  checkFile,
  draftOf,
  publishReducer,
  resumeStep,
  type FileProblem,
  type PublishFailReason,
  type PublishState,
  type SubmitStep,
} from '../lib/publishMachine'
import {
  UploadError,
  authorizeUpload,
  computeFileHash,
  directUpload,
  preflightUpload,
} from '../lib/uploadApi'

/**
 * 发布流程 —— 把「选文件 → 算哈希 → 签授权 → 直传 → 创建交易 → 等上链」
 * 串起来。纯逻辑在 `lib/publishMachine.ts`,网络在 `lib/uploadApi.ts`,
 * 这里只管**接线**。
 *
 * ## ⚠️ 与 `usePayFlow` 的关键差别:这里是**点击驱动**的
 *
 * `usePayFlow` 是"状态变了 → effect 去干活",因为它的起点是页面加载。
 * 发布不一样:用户不点「创建并上传」什么都不该发生 —— 尤其**不能自动弹钱包**。
 * 所以主流程是一个 `async` 函数(`publish`),由 onClick 触发。
 *
 * ## 唯一一个 effect:等链上回执
 *
 * `useWaitForTransactionReceipt` 是 hook,没法在 async 函数里 await,
 * 所以"等回执"这一步只能靠 effect。这是本文件唯一的 effect,
 * 其余全部在 `publish()` 里顺序执行 —— 顺序写出来比散在五个 effect 里
 * 好读得多,也**不容易出现"上一步还没完下一步就跑了"**。
 *
 * ## 算哈希与主流程分开
 *
 * 选完文件立刻就算哈希(用户还在填价格),而不是等点提交才算 ——
 * 大文件要一两秒,放在提交路径上会让人以为按钮卡住了。
 * 所以它有独立的入口 `pickFile`。
 */

/** 提交时要写进链上的价格与分账。由页面从它自己的校验结果里传进来 */
export type PublishTarget = {
  price: bigint
  recipients: readonly `0x${string}`[]
  splits: readonly number[]
}

export function usePublishFlow(contentId: Hex) {
  const { address, isConnected } = useAccount()
  const [state, dispatch] = useReducer(publishReducer, PUBLISH_INITIAL)
  const [progress, setProgress] = useState<number | null>(null)

  const { signTypedDataAsync } = useSignTypedData()
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })

  /**
   * 防连点。
   *
   * 与 `useUnlockFlow` 同一个理由,但这里更要紧:主流程里有**两次钱包弹窗**,
   * 而钱包弹窗期间按钮仍然是可点的。连点两下就是两笔创建交易 ——
   * 第二笔会 revert(`ContentAlreadyExists`),但用户的 gas 已经花了。
   */
  const running = useRef(false)

  // ── 选文件:立刻算哈希 ─────────────────────────────────────────────
  const pickFile = useCallback(async (file: File): Promise<FileProblem | null> => {
    // 门禁在这里先过一遍,过了才进状态机 —— 太大/空文件不该让界面
    // 先进"正在计算指纹"再失败
    const problem = checkFile(file, 'content')
    if (problem) return problem

    dispatch({ type: 'pick', file })
    try {
      dispatch({ type: 'hashed', hash: await computeFileHash(file) })
      return null
    } catch {
      // 读文件失败在正常浏览器里几乎不可能(文件被删/改权限)。退回重选
      dispatch({ type: 'reset' })
      return { k: 'unreadable' }
    }
  }, [])

  // ── 主流程 ─────────────────────────────────────────────────────────
  const publish = useCallback(
    async (target: PublishTarget, opts?: { skipUpload?: boolean }) => {
      const draft = draftOf(state)
      if (!draft || running.current) return
      if (!isConnected || !address) {
        dispatch({ type: 'fail', reason: 'not-connected' })
        return
      }

      /**
       * 从哪一步接上。
       *
       * ⚠️ 这里是"先上传后创建"顺序里最容易写错的地方,三种情形分开:
       * ① 首次 → `authorizing`
       * ② 重试 → 看 `uploaded`:传上去了就只能从 `creating` 接,
       *    再走一遍上传会撞上平台的防覆盖(见 `resumeStep`)
       * ③ 用户人工说"文件其实已经传上去了" → 直接 `creating`
       *
       * `state` 是这次渲染的闭包值,而它正是用户点击时所看到的那个 ——
       * 所以从它推导起点是对的,不能用 dispatch 之后的新值(那是拿不到同步结果的)。
       * 正因为起点由外部传入/推导,`publish` 里**不再** dispatch 一个 `submit`
       * 再去读结果 —— 那样读到的是旧 state。
       */
      const start: SubmitStep =
        opts?.skipUpload === true
          ? 'creating'
          : state.k === 'failed'
            ? resumeStep(state.uploaded)
            : 'authorizing'

      running.current = true
      setProgress(null)
      dispatch({ type: 'submit' })

      // 出错时用它判断"倒在哪一段" —— 同样是链上的失败,倒在上传那一段
      // 和倒在创建那一段,用户要做的事完全不一样
      let phase: SubmitStep = start
      try {
        if (start === 'authorizing') {
          phase = 'authorizing'
          dispatch({ type: 'step', step: 'authorizing' })
          const wire = await authorizeUpload({
            contentId,
            target: 'content',
            uploader: address,
            signTypedData: signTypedDataAsync,
          })

          /**
           * ★ 预检 —— 在真正上传之前,把"重试也修不好"的错误如实问出来。
           *
           * ⚠️ 顺序必须是"先签名再预检":预检要验签名,没签名它只能回 400。
           * 代价是配置错了的部署会先花掉用户一次签名 —— 可接受,那是一次
           * **不花钱**的签名,而且这条路只有部署者会走。
           */
          await preflightUpload(wire)

          phase = 'uploading'
          dispatch({ type: 'step', step: 'uploading' })
          await directUpload({
            file: draft.file,
            target: 'content',
            pathname: uploadPathname('content', contentId),
            wire,
            onProgress: setProgress,
          })
          dispatch({ type: 'uploaded' })
        }

        // 创建交易(花钱,这是第二次钱包弹窗)
        phase = 'creating'
        dispatch({ type: 'step', step: 'creating' })
        const hash = await write.writeContractAsync({
          abi: creatorSplitterAbi,
          address: SPLITTER_ADDRESS,
          functionName: 'createContent',
          // 顺序是 contentId / price / contentHash / recipients / splits。
          // `contentHash` 现在是**真的文件 keccak256**(方案 §8.1 冻结的定义)——
          // W4 一直传 `0x0`,那是明确的占位符,从 W5 起它兑现了
          args: [contentId, target.price, draft.hash, target.recipients, target.splits],
        })
        dispatch({ type: 'sent', txHash: hash })
        // 之后交给下面那个 effect 等回执
      } catch (e) {
        dispatch({ type: 'fail', reason: reasonFor(e, phase), detail: shortReason(e) })
      } finally {
        running.current = false
        setProgress(null)
      }
    },
    [state, contentId, address, isConnected, signTypedDataAsync, write],
  )

  // ── 等回执(本文件唯一的 effect) ────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'working' || state.step !== 'mining') return

    if (receipt.isSuccess) {
      dispatch({ type: 'done', txHash: state.txHash ?? write.data! })
    } else if (receipt.isError) {
      // 上链失败**不是**上传失败 —— 文件好好地在上头,重试会跳过上传
      dispatch({ type: 'fail', reason: chainReasonOnReceipt(receipt.error), detail: shortReason(receipt.error) })
    }
  }, [state, receipt.isSuccess, receipt.isError, receipt.error, write.data])

  /**
   * 重新开始。
   *
   * ⚠️ 调用方**必须同时换一个 contentId** —— 合约里 `createContent` 有
   * `if (_contents[contentId].exists) revert ContentAlreadyExists`,
   * 用同一个 id 建第二次是必定失败的;而 pathname 也由 contentId 决定,
   * 同一个 id 还意味着往一条已经写过的路径再传一次(平台会拒)。
   * 所以这里只清状态,换 id 由页面负责(见 `CreatePage` 的 `restart`)。
   */
  const reset = useCallback(() => {
    running.current = false
    write.reset()
    setProgress(null)
    dispatch({ type: 'reset' })
  }, [write])

  return { state, progress, pickFile, publish, reset }
}

/**
 * 异常 → 失败原因。
 *
 * 顺序是有讲究的:
 * ① `UploadError` 已经在 `uploadApi` 里归好类了(服务端的 code 就在里面),
 *    直接用它 —— 那是最精确的一手信息。
 * ② 钱包拒签在任何一段都可能发生,且优先级高于"倒在哪一段"。
 * ③ 剩下的按**倒在哪一段**分:倒在创建交易那一段才叫链上失败;
 *    倒在上传那一段的其它异常是网络/钱包问题,不该显示成"gas 不够"。
 */
function reasonFor(e: unknown, phase: SubmitStep): PublishFailReason {
  if (e instanceof UploadError) return e.reason
  if (isUserRejection(e)) return 'user-rejected'
  return phase === 'creating' || phase === 'mining' ? 'chain' : 'unavailable'
}

/**
 * 等回执时失败 —— 比 `reasonFor` 多一条要紧的分支。
 *
 * ⚠️ `receipt-timeout` **不等于失败**。它只说明我们没等到收据,
 * 交易可能已经上链了。这时给"重试"会让用户再签一次、再花一次 gas。
 * 同一条纪律见 `payMachine` 的 `RECEIPT_TIMEOUT_NOTE`。
 */
function chainReasonOnReceipt(err: unknown): PublishFailReason {
  if (isUserRejection(err)) return 'user-rejected'
  return err instanceof Error && err.name === 'WaitForTransactionReceiptTimeoutError'
    ? 'chain-timeout'
    : 'chain'
}

/** 供组件显示"这一步在干嘛" */
export type { PublishState, SubmitStep }
