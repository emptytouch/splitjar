import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { useUnlockFlow } from '../hooks/useUnlockFlow'
import { downloadWithName, navigateToDownload } from '../lib/download'
import { UNLOCK_STEP_COPY, describeUnlockFailure, secondsLeft } from '../lib/unlockMachine'

/**
 * 「下载内容」按钮 —— 付费门禁的前端出口(方案 §9.2)。
 *
 * ## 它是 `Recovery` 里那个 `download` 的真正实现
 *
 * 在此之前,`PayStatus` 的 `download` 分支写的是"下载功能在 W5 开放"
 * (一个诚实的占位)。这里就是 W5 兑现它的地方 —— 付款成功和
 * "你已经买过了"两种情形都会渲染这个组件。
 *
 * ## ⚠️ 「下载」其实是**三次加密学动作**,不是一次点击
 *
 * ```
 * 取 nonce  →  钱包签名(EIP-712,不花钱不上链)  →  换取 60 秒 URL
 * ```
 *
 * 三次等待都必须有可见进度,否则用户会以为卡死了 —— 尤其是签名那一步,
 * 钱包会弹一个**看起来像又要付钱**的框。文案在 `UNLOCK_STEP_COPY` 里。
 *
 * ## 关于下载下来那个文件名
 *
 * Blob 的 pathname 就是文件名,而我们冻结的 pathname 是
 * `content/<contentId>`(见 `shared/storage.ts`)—— 所以只把 URL 交给浏览器,
 * 存到本地就是一个叫 `0x6410fb09…` 的、**没有扩展名的**文件。
 *
 * ⚠️ **2026-09-23 实测:字节一直是对的,问题只在名字。**
 *
 * 用户报「本地无法打开」。核对下来本地文件的 keccak256 与链上 `contentHash`
 * **逐字节一致** —— 内容是好的,只是 Windows 没有扩展名就认不出类型。
 *
 * 曾经把这件事记成"确定性 pathname 的已知代价"并接受了。**那个结论下错了**,
 * 因为"文件名"和"pathname"其实可以解耦:字节取回内存之后,名字由我们定。
 * 做法与代价(以及另外三条为什么走不通)全在 `lib/download.ts` 的文件头。
 *
 * 而"点了下载却只是打开"那个更严重的问题,修在服务端(`api/unlock.ts` 的
 * `getDownloadUrl`),不在这个组件里。完整来龙去脉见方案 §20.4.5.1。
 */

/** 每秒重渲染一次,用来走倒计时。只在需要时才起定时器 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

/**
 * 下载进到哪一步了。
 *
 * 为什么不复用 `useUnlockFlow` 的状态:那台机器管的是**拿到 URL 之前**
 * 的三步(取 nonce → 签名 → 换 URL),而这里管的是**拿到 URL 之后**
 * 把字节搬回家。两件事的失败后果也不同 —— 前面那种失败可以重试签名,
 * 后面这种失败要回退到"把 URL 直接交给浏览器"。
 */
type DownloadPhase =
  /** 正在取字节 —— 文件大时这一步要等一会儿,不能装作已经下完了 */
  | 'preparing'
  /** 起名成功,文件已交给浏览器 */
  | 'named'
  /** 起名那条路走不通,已回退成直接导航(修复前的老行为) */
  | 'fallback'

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
      role="status"
      aria-label="处理中"
    />
  )
}

export function UnlockButton({ contentId, filenameBase }: { contentId: Hex; filenameBase?: string }) {
  const { state, unlock, reset, canStart } = useUnlockFlow(contentId)

  /**
   * ⚠️ 两个 hook 都必须在**任何 early return 之前**无条件调用。
   *
   * 下面按 `state.k` 分了四个分支各自 return,所以这里一旦把 hook 写进
   * 某个分支里,渲染次数一变 hook 的调用顺序就变了 —— React 会直接报
   * "Rendered fewer hooks than expected",而那个报错发生在切换状态的瞬间,
   * 看起来像是"点了没反应"。
   *
   * `useNow` 自己会判断要不要真的起定时器(只有 `ready` 才需要走字)。
   */
  const now = useNow(state.k === 'ready')

  const [phase, setPhase] = useState<DownloadPhase>('preparing')

  /**
   * 走一次完整下载:**先试着起名,不行就回退**。
   *
   * ⚠️ 回退那条路很重要,别当成不会发生。`downloadWithName` 要跨源 `fetch`
   * 那个 blob 域名,而**本机验证不了它是否允许 CORS**(那域名在本机
   * `ECONNRESET`,2026-09-23 实测)。回退之后的行为就是修复前的老样子:
   * 文件下得来、名字难看。**最坏不比现在差。**
   */
  const runDownload = useCallback(
    (url: string) => {
      setPhase('preparing')
      void downloadWithName(url, filenameBase || contentId).then((named) => {
        if (named) {
          setPhase('named')
          return
        }
        navigateToDownload(url)
        setPhase('fallback')
      })
    },
    [filenameBase, contentId],
  )

  /**
   * 自动触发下载,但**每条 URL 只触发一次**。
   *
   * 为什么用 ref 而不是靠 state 判重:`now` 每秒都变,组件每秒重渲染,
   * 用 state 做条件会反复触发、反复取一遍整个文件。
   *
   * 依赖里带 `runDownload` 是安全的 —— 它的身份变了会让 effect 重跑,
   * 但上面那道 `firedUrl` 闸门会挡住第二次下载。
   */
  const firedUrl = useRef<string | null>(null)
  useEffect(() => {
    if (state.k !== 'ready') return
    if (firedUrl.current === state.url) return
    firedUrl.current = state.url
    runDownload(state.url)
  }, [state, runDownload])

  if (state.k === 'ready') {
    const left = secondsLeft(state.expiresAt, now)
    const expired = left === 0
    /**
     * ⚠️ 「已开始下载」**不能无条件说** —— 起名那条路要先取字节,
     * 大文件不是瞬间的事。说早了就是在骗人,而用户会去下载栏找一个
     * 还没出现的文件。
     *
     * 回退那一态(`fallback`)的说法要**同时覆盖两种落点**:它走的是
     * `target="_blank"` 导航,响应带 `Content-Disposition` 时就落下载栏,
     * 不带时就是开一个新标签页 —— 事先分不出来,所以两个都提一句。
     * 别写成「已开始下载」:链接过期时那个标签页其实是一张错误页。
     */
    const headline = expired
      ? '下载链接已过期'
      : phase === 'preparing'
        ? '正在准备文件…'
        : phase === 'named'
          ? '✓ 已开始下载'
          : '✓ 已交给浏览器,留意下载栏或新标签页'
    return (
      <div className="space-y-3">
        <div
          className={`rounded-xl border px-4 py-3.5 ${
            expired ? 'border-amber-400/30 bg-amber-400/[0.06]' : 'border-emerald-400/30 bg-emerald-400/[0.06]'
          }`}
        >
          <p className="text-sm leading-relaxed text-neutral-100">{headline}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            {expired ? (
              <>链接的有效期只有 60 秒 —— 这是故意的,外流了也基本没用。重新获取即可。</>
            ) : (
              <>
                链接 <span className="tnum text-neutral-300">{left}</span> 秒后失效。
                内容一旦下载到本机就不再受这道门禁约束 —— 这是所有"下载式"防泄露的共同边界。
              </>
            )}
          </p>
        </div>

        {expired ? (
          <button
            type="button"
            onClick={unlock}
            className="w-full rounded-xl bg-accent px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-soft"
          >
            重新获取下载链接
          </button>
        ) : (
          <button
            type="button"
            onClick={() => runDownload(state.url)}
            className="w-full rounded-xl border border-line bg-surface-2 px-5 py-2.5 text-xs text-neutral-200 transition-colors hover:border-accent"
          >
            没开始下载?点这里
          </button>
        )}
      </div>
    )
  }

  if (state.k === 'working') {
    const copy = UNLOCK_STEP_COPY[state.step]
    return (
      <div className="rounded-xl border border-line bg-surface-2/60 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Spinner />
          <p className="text-sm leading-relaxed text-neutral-100">{copy.title}</p>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{copy.hint}</p>
      </div>
    )
  }

  if (state.k === 'failed') {
    const d = describeUnlockFailure(state.reason, state.step)
    return (
      <div className="space-y-3">
        <div className={`rounded-xl border px-4 py-3.5 ${d.canRetry ? 'border-amber-400/30 bg-amber-400/[0.06]' : 'border-accent/35 bg-accent/[0.07]'}`}>
          <p className="text-sm leading-relaxed text-neutral-100">{d.title}</p>
          {d.hint && <p className="mt-1.5 text-xs leading-relaxed text-muted">{d.hint}</p>}
          {/* 服务端原始的 code 原样显示 —— 排查时看得到,平时不占视线 */}
          {state.detail && (
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted/70 break-all">
              {state.detail}
            </p>
          )}
        </div>
        <div className="flex gap-2.5">
          {d.canRetry && (
            <button
              type="button"
              onClick={unlock}
              className="flex-1 rounded-xl bg-accent px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-soft"
            >
              再试一次
            </button>
          )}
          <button
            type="button"
            onClick={reset}
            className="flex-1 rounded-xl border border-line bg-surface-2 px-5 py-3 text-sm text-neutral-200 transition-colors hover:border-accent"
          >
            {d.canRetry ? '先不下载' : '知道了'}
          </button>
        </div>
      </div>
    )
  }

  // idle
  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={unlock}
        disabled={!canStart}
        className="w-full rounded-xl bg-accent px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-45"
      >
        下载内容
      </button>
      <p className="text-center text-[11px] leading-relaxed text-muted">
        点一下会请你在钱包里签个名 —— 不花钱、不上链。签名只是证明"你就是买家",
        服务端核对链上记录后给一条 60 秒有效的下载链接。
      </p>
    </div>
  )
}

