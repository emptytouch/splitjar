import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSignTypedData, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { uploadPathname, type UploadTarget } from '../../shared/storage'
import { RECEIPT_TIMEOUT_MS, isUserRejection, shortReason } from '../lib/payErrors'
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
  publishContentTitle,
} from '../lib/uploadApi'
import { derivePreview, previewBlobOf } from '../lib/previewDerive'
import type { UploadAuthWire } from '../../shared/upload'

/**
 * 发布流程 —— 把「选文件 → 算哈希 + 派生预览图 → 签授权 → 直传(内容 + 预览图)
 * → 创建交易 → 等上链」串起来。纯逻辑在 `lib/publishMachine.ts`,
 * 网络在 `lib/uploadApi.ts`,预览图的派生在 `lib/previewDerive.ts`,
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
  /**
   * 服务端的**可读标题** —— ⚠️ **它不上链**(合约里没有这个字段)。
   * 它写进 KV,给 `GET /api/catalog` 用,好让 agent 看得懂买的是什么。
   * 详见 `usePublishFlow` 里 `pendingTitle` 那段
   */
  title: string
  price: bigint
  recipients: readonly `0x${string}`[]
  splits: readonly number[]
}

export function usePublishFlow(contentId: Hex) {
  const { address, isConnected } = useAccount()
  const [state, dispatch] = useReducer(publishReducer, PUBLISH_INITIAL)
  const [progress, setProgress] = useState<number | null>(null)

  /**
   * 标题有没有写进服务端。`null` = 还没创建成功过。
   *
   * ⚠️ **刻意放在状态机外面。** 写标题与"发布成功没有"是两件正交的事:
   * 标题只是 catalog 里给人看的一行字(见 `shared/agentPay.ts`),
   * 写不进去**不改发布的结果** —— 内容已经上链、钱已经花了。
   * 塞进 reducer 会让状态机多出"创建成功但标题失败"这种假状态。
   */
  const [titleSaved, setTitleSaved] = useState<boolean | null>(null)

  /**
   * 从 `publish()` 传给"等回执"那个 effect 的两样东西。
   *
   * ## ⚠️ 为什么非要一个 ref 不可
   *
   * 标题只能写在**回执成功之后**(在那之前合约里没有 `creator`,归属检查必回
   * 404),而回执是 `useWaitForTransactionReceipt` 给的 —— 它是个 hook,
   * **没法在 async 函数里 await**,所以那一步只能待在 effect 里。
   * 而 `wire` 是 `publish()` 的局部变量、`title` 来自页面的 `PublishTarget`,
   * 两者都在 effect 的闭包外。
   *
   * ## ⚠️ `wire` 可能是 `null` —— 重试路径会丢签名
   *
   * 从 `creating` 接上的两条路(重试 / `skipUpload`)上一次已经传过文件了,
   * 那条 `Upload` 签名是**上一次调用**签的,这次调用里根本没有它。
   * 这种情况下**不重签,直接放弃标题** —— 理由是不为一行装饰再弹一次钱包,
   * 代价是重试路径创建的内容 catalog 里没有标题(如实记在文档里,不是静默 bug)。
   */
  const pendingTitle = useRef<{ wire: UploadAuthWire | null; title: string } | null>(null)

  const { signTypedDataAsync } = useSignTypedData()
  const write = useWriteContract()
  /**
   * ⚠️ `timeout` 与 `query.retry` **都必须显式给**,理由见 `RECEIPT_TIMEOUT_MS`:
   * viem 默认 180 秒,再乘上全局的 `retry: 1` 就是 6 分钟 ——
   * 用户看到的就是一个转了六分钟、没有任何出口的「上链中…」。
   *
   * ⚠️ 发布这条更要紧:这里已经花掉了一次 gas,用户最需要尽快知道"到底成没成"。
   * 超时会掉进 `chain-timeout`,那条文案是「没等到链上的回执」并且
   * `canRetry: false` —— 见 `publishMachine.ts`。
   */
  const receipt = useWaitForTransactionReceipt({
    hash: write.data,
    timeout: RECEIPT_TIMEOUT_MS,
    query: { retry: false },
  })

  /**
   * 防连点。
   *
   * 与 `useUnlockFlow` 同一个理由,但这里更要紧:主流程里有**两次钱包弹窗**,
   * 而钱包弹窗期间按钮仍然是可点的。连点两下就是两笔创建交易 ——
   * 第二笔会 revert(`ContentAlreadyExists`),但用户的 gas 已经花了。
   */
  const running = useRef(false)

  // ── 选文件:立刻算哈希 + 派生预览图 ────────────────────────────────
  const pickFile = useCallback(async (file: File): Promise<FileProblem | null> => {
    // 门禁在这里先过一遍,过了才进状态机 —— 太大/空文件不该让界面
    // 先进"正在计算指纹"再失败
    const problem = checkFile(file, 'content')
    if (problem) return problem

    dispatch({ type: 'pick', file })
    try {
      /**
       * ⚠️ 两件事**并行**跑,不排队。
       *
       * 它们互不依赖 —— 一个读字节算 keccak256,一个解码取一帧画面。
       * 串行的话大文件会白白多等一个来回,而这个等待发生在"选完文件"
       * 到"能提交"之间,是用户最盯着看的那一段。
       *
       * ⚠️ `derivePreview` **永不抛**(它把解不开的文件收成 `unavailable`,
       * 那是一条正常出路,见 `lib/previewDerive.ts`)。所以这里的 `catch`
       * 实际上只可能接住 `computeFileHash` 抛的东西 —— 也就是"读不出文件"。
       */
      const [hash, preview] = await Promise.all([computeFileHash(file), derivePreview(file)])
      dispatch({ type: 'hashed', hash, preview })
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
      setTitleSaved(null)
      // 先把标题记下来(此刻还没有 `wire`);拿到签名后再补进第二个字段
      pendingTitle.current = { wire: null, title: target.title }
      dispatch({ type: 'submit' })

      // 出错时用它判断"倒在哪一段" —— 同样是链上的失败,倒在上传那一段
      // 和倒在创建那一段,用户要做的事完全不一样
      /**
       * 这次要往哪几个 store 写 —— **一次签名覆盖全部**(2026-09-25 起)。
       *
       * ⚠️ 有预览图就同时授权 `preview`,没有就只授权 `content`。
       * 派生不出来的类型(PDF/压缩包)走的是后者,那条路和 W13 之前完全一样。
       * 刻意**不**无条件写上 `preview`:签名里列了却没用到,
       * 等于白给一条"可以往公开 store 写"的授权。
       *
       * ⚠️ 顺序即签名的一部分,服务端逐元素比对 —— 见 `authorizeUpload`
       */
      const previewBlob = previewBlobOf(draft.preview)
      const targets: readonly UploadTarget[] = previewBlob ? ['content', 'preview'] : ['content']

      let phase: SubmitStep = start
      try {
        if (start === 'authorizing') {
          phase = 'authorizing'
          dispatch({ type: 'step', step: 'authorizing' })
          const wire = await authorizeUpload({
            contentId,
            targets,
            uploader: address,
            signTypedData: signTypedDataAsync,
          })
          // 拿到签名了 —— 它等下要拿去写标题(见 `pendingTitle` 的说明)
          if (pendingTitle.current) pendingTitle.current.wire = wire

          /**
           * ★ 预检 —— 在真正上传之前,把"重试也修不好"的错误如实问出来。
           *
           * ⚠️ 顺序必须是"先签名再预检":预检要验签名,没签名它只能回 400。
           * 代价是配置错了的部署会先花掉用户一次签名 —— 可接受,那是一次
           * **不花钱**的签名,而且这条路只有部署者会走。
           *
           * ⚠️ 它会**逐个 pathname** 验一遍(见 `api/upload.ts` 的 `preflight`),
           * 所以"公开 store 那份凭证没配"这种错在这里就会被指出来,
           * 而不是等内容传完、轮到预览图时才炸。
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

          /**
           * 预览图 —— **尽力而为,失败了不挡发布**。
           *
           * 理由与下面那个"写标题"完全相同:内容已经在存储里了,
           * 而预览图只是广场网格里的一张索引图(见 `lib/previewDerive.ts`)。
           * 让它把整次发布变成失败,代价是用户白重传一次几百 MiB 的内容。
           *
           * ⚠️ 也**不能**反过来"失败就退回 `authorizing` 重试":重试会把
           * `content/<contentId>` 再写一遍,而平台 `allowOverwrite: false`
           * 会直接拒 —— 用户看到的就成了"重试也没用"。
           * 补预览图的正当入口在内容看板,不在重试。
           *
           * ⚠️ 副作用:进度条会从 100% 掉回 0 再走一遍。那是预览图在传,
           * 它是几百 KB 的图,一闪而过;不为它单独做一段文案和状态。
           */
          if (previewBlob) {
            try {
              await directUpload({
                file: previewBlob,
                target: 'preview',
                pathname: uploadPathname('preview', contentId),
                wire,
                onProgress: setProgress,
              })
            } catch (e) {
              console.warn(
                '[splitjar] 预览图没能传上去 —— 内容本身不受影响,广场上这一件会没有缩略图',
                e,
              )
            }
          }

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

      // ── 标题:尽力而为,写在**创建成功之后** ──────────────────────────
      //
      // ⚠️ 这一段**绝不能**把上面那个 `done` 变成失败。内容已经上链、钱已经花了,
      // 而标题只是 catalog 里的一行展示文字。所以:
      //   - 不 await 它(不让一次往返拖慢成功界面)
      //   - 不 throw 出去(状态机停在"正在上链"会是最糟的结果)
      //   - 失败只落成一个 `false`,由页面决定要不要提一句
      //
      // ⚠️ 先把 ref 清掉再干活 —— 这个 effect 会因为 `receipt.isSuccess`
      // 一直是 true 而**重复执行**,不清就等于把标题写两遍、还会覆盖掉结果。
      const pending = pendingTitle.current
      pendingTitle.current = null
      if (pending) {
        if (!pending.wire) {
          // 重试 / `skipUpload` 路径拿不到签名(见 `pendingTitle` 的说明)——
          // 不重签,放弃标题。**这不是静默失败**:控制台留一行
          console.warn('[splitjar] 从上传之后的步骤接上,没有 Upload 签名,标题未写入服务端')
          setTitleSaved(false)
        } else {
          void publishContentTitle({
            contentId,
            title: pending.title,
            wire: pending.wire,
          }).then(
            () => setTitleSaved(true),
            (e) => {
              // 最常见的原因就是那条 5 分钟的 `deadline` 过期了(见 uploadApi.ts)。
              // 内容本身没问题,只是 catalog 里这一行标题会变成 null
              console.warn('[splitjar] 标题没能写进服务端,内容本身已创建成功', e)
              setTitleSaved(false)
            },
          )
        }
      }
    } else if (receipt.isError) {
      // 上链失败**不是**上传失败 —— 文件好好地在上头,重试会跳过上传
      dispatch({ type: 'fail', reason: chainReasonOnReceipt(receipt.error), detail: shortReason(receipt.error) })
    }
  }, [state, receipt.isSuccess, receipt.isError, receipt.error, write.data, contentId])

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
    // ⚠️ 也要清掉待写的标题 —— 换 `contentId` 重新开始之后,
    // 留着上一份内容的 `wire` 会拿旧签名去写新内容(服务端会以 `content_claimed`
    // 或验签失败拒掉,但那是一类本不该发出的请求)
    pendingTitle.current = null
    setTitleSaved(null)
    dispatch({ type: 'reset' })
  }, [write])

  return { state, progress, titleSaved, pickFile, publish, reset }
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
