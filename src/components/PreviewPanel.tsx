import { useEffect, useState } from 'react'
import { PREVIEW_MAX_EDGE, describePreview, type PreviewDerivation } from '../lib/previewDerive'

/**
 * 「这张预览图会长什么样」—— 选完文件之后显示派生出来的那张图。
 *
 * ## 为什么必须让创作者**看见**它
 *
 * 这张图是**派生**出来的,不是他挑的 —— 他不知道我们截了哪一帧、
 * 打了多重的码。而它接下来会**公开在广场上**,任何人拿到直链都能存下来。
 * 让一个人把一张自己没见过的图公开出去,是说不通的。
 *
 * 所以这个面板有两个作用:① 让他看见;② 说清楚它去哪(公开 CDN)。
 *
 * ## ⚠️ 派生不出来时**不显示成错误**
 *
 * PDF、压缩包、读不出画面的文件都会得到 `unavailable`,而那是**正常出路**
 * (见 `lib/previewDerive.ts` 文件头:允许无预览图发布)。用红色报错框
 * 显示它,创作者会以为得回去换一个文件 —— 可他换什么文件都还是 PDF。
 */
export function PreviewPanel({ derivation }: { derivation: PreviewDerivation | null }) {
  const url = useObjectUrl(derivation?.k === 'derived' ? derivation.blob : null)

  // 还没选文件 —— 整块不出现
  if (!derivation) return null

  return (
    <div className="rounded-xl border border-line-soft bg-surface-2/30 p-4">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted">预览图(广场上那一格)</span>
        {derivation.k === 'derived' && (
          <span className="shrink-0 text-[11px] text-muted/70 tnum">
            {derivation.width}×{derivation.height}
          </span>
        )}
      </div>

      {derivation.k === 'derived' ? (
        <>
          <div className="overflow-hidden rounded-lg border border-line-soft bg-ink">
            {url ? (
              <img src={url} alt="将要公开的预览图" className="block h-auto w-full" />
            ) : (
              // object URL 的生成是同步的,这一格实际上到不了 ——
              // 留着是为了类型上不需要 `!`,也避免以后把它改成异步时白屏
              <div className="grid h-32 place-items-center text-[11px] text-muted">载入中…</div>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted/70">
            {describePreview(derivation)}
          </p>
          {/*
            ⚠️ 「公开」这两个字必须出现。创作者很容易以为预览图和内容一样是私有的,
            然后传一份**本身就是卖点**的截图进来 —— 那张图一旦上了公开 CDN,
            这份内容就等于白送了。水印只是止损,不是许可
          */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300/80">
            ⚠️ 注意:这张图在广场上是公开的(任何人拿到直链都能存下来),内容本身仍然是付费的。
            水印是真打上去的,不是显示效果。
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted/70">
            最长边压到 {PREVIEW_MAX_EDGE}px,由你的浏览器本地生成 —— 原图不会离开这台机器。
          </p>
        </>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted">
          {describePreview(derivation)}
        </p>
      )}
    </div>
  )
}

/**
 * 一个 blob 的 `object:` URL,卸载或换 blob 时自动 revoke。
 *
 * ⚠️ **不 revoke 就是内存泄漏**:一张 1200px 的位图在 object URL 里
 * 会一直被浏览器攥着,直到整页刷新。而创作者选文件是可以反反复复换的
 * (选错了、想比较两张图),每换一次就漏一张。
 */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const created = URL.createObjectURL(blob)
    setUrl(created)
    return () => URL.revokeObjectURL(created)
  }, [blob])

  return url
}
