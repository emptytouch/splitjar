import { useCallback, useReducer, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useAccount, useSignTypedData } from 'wagmi'
import { MAX_UPLOAD_BYTES, uploadPathname } from '../../shared/storage'
import { isVerifiableHash } from '../../shared/contentHash'
import { isUserRejection, shortReason } from '../lib/payErrors'
import type { PreviewDerivation } from '../lib/previewDerive'
import { derivePreview } from '../lib/previewDerive'
import {
  BACKFILL_INITIAL,
  backfillReducer,
  previewOf,
  type BackfillFailReason,
} from '../lib/backfillMachine'
import {
  authorizeUpload,
  classifyUploadError,
  computeFileHash,
  directUpload,
  preflightUpload,
} from '../lib/uploadApi'
import type { PublishFailReason } from '../lib/publishMachine'

/**
 * 「补预览图」—— 把「选原文件 → 核对指纹 → 派生 → 签授权 → 传公开 store」
 * 串起来。纯逻辑在 `lib/backfillMachine.ts`,网络在 `lib/uploadApi.ts`,
 * 派生在 `lib/previewDerive.ts`,这里只管**接线**。
 *
 * 与 `usePublishFlow` 同一个写法(点击驱动,不是"状态变了就干活"),
 * 理由也一样:用户不点,什么都不该发生 —— 尤其**不能自动弹钱包**。
 *
 * ## ⚠️ 它复用了发布那条路的**每一个**离开浏览器的动作
 *
 * `authorizeUpload` / `preflightUpload` / `directUpload` 一个都没重写,
 * 连参数形状都一样(只是 `targets` 从 `['content','preview']` 收成
 * `['preview']`)。这不是省事 —— 这条路上"新写的代码"每一行都是一个新的
 * 出错机会,而那几个函数已经在真浏览器里跑通过一遍
 * (见 `scripts/drive-publish.mjs`)。
 *
 * ## ⚠️ 一次签名,而且**只授权 preview 一个 store**
 *
 * 补图动的是预览图那一格,内容本身一个字节都不该被重写。签名里写上
 * `content` 等于白给一条"可以往私有 store 写"的授权 —— 见
 * `shared/upload.ts` 那段"一条签名应该只够干一件事"。
 */
export function usePreviewBackfill(args: {
  contentId: Hex
  /** 链上记的那份内容文件的 keccak256。零值表示核对不了(见 shared/contentHash.ts) */
  contentHash: Hex | null
  /** 传成功之后叫一声 —— 由调用方去刷新那份预览图列表 */
  onUploaded: () => void
}) {
  const { contentId, contentHash, onUploaded } = args

  const { address, isConnected } = useAccount()
  const { signTypedDataAsync } = useSignTypedData()
  const [state, dispatch] = useReducer(backfillReducer, BACKFILL_INITIAL)
  const [progress, setProgress] = useState<number | null>(null)

  /**
   * 防连点。
   *
   * 主流程里有一次钱包弹窗,而**弹窗期间按钮仍然是可点的** ——
   * 连点两下就是两次签名、两次 PUT 到同一条 pathname,而第二次会被
   * 平台的防覆盖拒掉,变成一次看不懂的失败。与 `usePublishFlow` 同一个 ref。
   */
  const running = useRef(false)

  // ── 选文件:核对 + 派生 ─────────────────────────────────────────────
  const pick = useCallback(
    async (file: File) => {
      dispatch({ type: 'start' })

      /**
       * 两道**本地**门禁。⚠️ 刻意不用 `checkFile`:
       *
       * 它比这里多判一条"类型在不在白名单里",而**内容文件不限制类型**
       * (`ALLOWED_CONTENT_TYPES.content` 是 `undefined`)—— 那条判断在这个
       * 场景下永远为假。搬过来只会多一条走不到的分支。
       * 体积上限仍然用**同一个常量**,那才是不能两处各写一份的东西。
       */
      if (file.size === 0) {
        dispatch({ type: 'refuse', reason: 'empty' })
        return
      }
      if (file.size > MAX_UPLOAD_BYTES.content) {
        dispatch({ type: 'refuse', reason: 'too-large' })
        return
      }

      let hash: Hex
      let derivation: PreviewDerivation
      try {
        // 两件事**并行**:一个读字节算 keccak256,一个解码取画面。
        // 与 `usePublishFlow.pickFile` 同一个理由 —— 串行会白白多等一个来回
        ;[hash, derivation] = await Promise.all([computeFileHash(file), derivePreview(file)])
      } catch {
        // `derivePreview` **永不抛**(它把解不开的文件收成 `unavailable`,
        // 见它的文件头)。所以这里只可能接住 `computeFileHash` 抛的
        // —— 也就是"读不出这个文件"
        dispatch({ type: 'refuse', reason: 'unreadable' })
        return
      }

      /**
       * ⭐ 核对:**先比指纹,再判有没有图。**
       *
       * 顺序是刻意的。两样都不对时(既选错了文件、它又是个 PDF),
       * 更该被说出来的是"你选错文件了" —— 那一句才是他能动手解决的。
       *
       * ⚠️ 这一步**必须在签名之前**,它是"一张对不上的图不会挂到广场上"
       * 的唯一保证。
       */
      const verifiable = isVerifiableHash(contentHash)
      if (verifiable && hash.toLowerCase() !== contentHash.toLowerCase()) {
        dispatch({
          type: 'refuse',
          reason: 'file-mismatch',
          // 把两个指纹都摆出来 —— 这是**证据**,不是错误码。
          // 只写一句"校验失败"会让创作者无从判断自己是不是选错了
          detail: `选中的文件 ${hash.slice(0, 10)}… · 链上记的是 ${contentHash.slice(0, 10)}…`,
        })
        return
      }

      if (derivation.k === 'unavailable') {
        // 正常出路,不是失败 —— 见 `lib/previewDerive.ts` 文件头
        dispatch({ type: 'no-preview' })
        return
      }

      dispatch({ type: 'checked', preview: derivation, hashVerified: verifiable })
    },
    [contentHash],
  )

  // ── 主流程 ─────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    if (running.current) return

    // ⚠️ 先判钱包、再动状态机。这条失败落在 `ready` / `failed` 上,
    // 而那两个状态都还攥着图 —— 「重试」不会因为连不上钱包就消失
    if (!isConnected || !address) {
      dispatch({ type: 'fail', reason: 'not-connected' })
      return
    }

    /**
     * ⚠️ 从**这次渲染的闭包**里取那张图,而不是 dispatch 之后再读 ——
     * 后者读到的是旧 state。这正是"起点由外部推导、不在 reducer 里回读"
     * 那条纪律(见 `usePublishFlow.publish` 里那段)。
     */
    const preview = previewOf(state)
    if (!preview) return

    running.current = true
    setProgress(null)
    dispatch({ type: 'submit' })

    try {
      const wire = await authorizeUpload({
        contentId,
        // ⚠️ 只有 `preview`。见文件头那段
        targets: ['preview'],
        uploader: address,
        signTypedData: signTypedDataAsync,
      })

      /**
       * 预检 —— 先问一次"这次上传有没有重试也修不好的毛病"。
       *
       * 与发布那条用**同一个函数**。最要紧的是它会在 PUT 之前指出
       * "公开 store 那份凭证没配" —— 否则那个错要等到 SDK 抛一句
       * 没有状态码、没有 code 的笼统错误才暴露(见 `api/upload.ts` 的 `preflight`)。
       */
      await preflightUpload(wire)

      dispatch({ type: 'step', step: 'uploading' })
      await directUpload({
        file: preview.blob,
        target: 'preview',
        pathname: uploadPathname('preview', contentId),
        wire,
        onProgress: setProgress,
      })

      dispatch({ type: 'done' })
      // 入口会在调用方重新拉到预览图列表之后消失
      onUploaded()
    } catch (e) {
      dispatch({ type: 'fail', reason: reasonFor(e), detail: shortReason(e) })
    } finally {
      running.current = false
      setProgress(null)
    }
  }, [state, contentId, address, isConnected, signTypedDataAsync, onUploaded])

  /** 收起面板 / 换一个文件。两者在这里是同一个动作:回到"还没选" */
  const reset = useCallback(() => {
    running.current = false
    setProgress(null)
    dispatch({ type: 'reset' })
  }, [])

  return { state, progress, pick, submit, reset }
}

/**
 * `PublishFailReason` → `BackfillFailReason`。
 *
 * ⚠️ 与 `uploadApi.ts` 的 `CODE_TO_REASON` 是**两张不同的表**,不要合并:
 * 同一个 code 在两条流程里的出路不一样。最明显的是 `claimed` ——
 * 发布时它意味着"这个编号被别人占了,换一个编号再来",而补图时编号是
 * **已有的**、换不掉,真正的出路是换个钱包(所以这里映射成 `not-owner`)。
 *
 * 写成 `Record<...>` 而不是 `Partial<...>`,是为了让上游新增一个原因时
 * **这里编译报错** —— 否则新原因会静默落进兜底,而"某个失败永远显示成
 * 网络问题"是最难发现的那种 bug。
 */
const REASON_TO_BACKFILL: Record<PublishFailReason, BackfillFailReason> = {
  'user-rejected': 'user-rejected',
  'not-connected': 'not-connected',
  unavailable: 'unavailable',
  protocol: 'protocol',
  claimed: 'not-owner',
  // ⚠️ 下面三条在这条路上**不可能出现**,归一化到 `unavailable` 是兜底而非
  // 它们真的会发生:`wrong-chain` 只在写链时判,而这**不上链**;
  // `chain` / `chain-timeout` 要求先有一笔链上交易。
  // (同一条纪律见 `uploadApi.ts` 里把 agent 那六条归到 `protocol` 的注释。)
  'wrong-chain': 'unavailable',
  chain: 'unavailable',
  'chain-timeout': 'unavailable',
}

/**
 * 异常 → 失败原因。
 *
 * ⚠️ 先过一遍 `classifyUploadError`:它把"服务端明确告诉我们的"、
 * "用户拒签"、"钱包/viem 自己抛的"三类收敛成同一种东西,
 * `isUserRejection` 的判断只有那一处(与付款那条链路共用)。这里不重写。
 */
function reasonFor(e: unknown): BackfillFailReason {
  return REASON_TO_BACKFILL[classifyUploadError(e, isUserRejection).reason]
}
