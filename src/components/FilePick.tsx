import { useRef } from 'react'
import type { Hex } from 'viem'
import { formatBytes } from '../lib/publishMachine'

/**
 * 「选择内容文件」。
 *
 * ## 为什么把指纹显示得这么显眼
 *
 * 这个哈希是**买家能自己验的那一样东西** —— 他下载完可以算一遍,
 * 跟链上比对,证明拿到的东西没被掉包。所以创建的时候就要让创作者
 * **看得见它已经算出来了**,而不是藏在一行小字里。
 *
 * 演示时这是个很硬的点:"链上记的不是一个说法,是一个能验的指纹。"
 *
 * ## ⚠️ 选完文件立刻算哈希,不等到提交
 *
 * 大文件要一两秒。放进提交路径上的话,用户点完「创建并上传」会先愣一下,
 * 分不清是在算哈希还是在等钱包。所以这一步在**选文件那一刻**就做完,
 * 用户填价格的时候它已经好了。
 */

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
      role="status"
      aria-label="处理中"
    />
  )
}

export function FilePick({
  draft,
  hashing,
  hashingName,
  progress,
  error,
  disabled,
  onPick,
}: {
  /** 已经备好的文件 + 指纹。null 表示还没选 */
  draft: { file: File; hash: Hex } | null
  hashing: boolean
  /** 正在算指纹时那个文件名 —— 哈希还没出来,只能先显示它 */
  hashingName?: string
  /** 上传进度 0–100。null 表示没在上传 */
  progress: number | null
  /** 选文件那一刻的门禁错误(太大/空/类型),与表单其它错误同一类 */
  error?: string
  disabled: boolean
  onPick: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <div>
      <label className="mb-1.5 block text-xs text-muted" htmlFor="content-file">
        内容文件
      </label>

      {/* 真正的 input 藏起来 —— 原生控件没法跟这套视觉一致。
          但**不能用 `display:none`**:那样它连键盘和读屏都摸不到。
          `sr-only` 保留可聚焦性,下面那个 label 用 htmlFor 关联它 */}
      <input
        ref={input}
        id="content-file"
        type="file"
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          // 清空 value,**否则选同一个文件第二次不会触发 change** ——
          // 传失败了想重选同一个文件时会发现"点了没反应"
          e.target.value = ''
        }}
      />

      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled}
        className="w-full rounded-xl border border-dashed border-line bg-surface-2/40 px-4 py-5 text-left transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
      >
        {hashing ? (
          <span className="flex items-center gap-2.5">
            <Spinner />
            <span className="text-sm text-neutral-200">
              正在计算指纹…{hashingName && <span className="text-muted"> {hashingName}</span>}
            </span>
          </span>
        ) : draft ? (
          <span className="block space-y-2">
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm text-neutral-100">{draft.file.name}</span>
              <span className="shrink-0 text-xs text-muted tnum">{formatBytes(draft.file.size)}</span>
            </span>
            <span className="block">
              <span className="block text-[11px] text-muted">文件指纹(会上链)</span>
              <span className="mt-0.5 block break-all font-mono text-[11px] leading-relaxed text-neutral-300">
                {draft.hash}
              </span>
            </span>
            <span className="block text-[11px] text-muted/70">点一下可以换一个文件</span>
          </span>
        ) : (
          <span className="block text-center">
            <span className="text-sm text-neutral-200">点这里选文件</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-muted/70">
              PDF、视频、压缩包都行,大小不超过 200 MiB。文件不经过我们的服务器,直接从你的浏览器传到存储。
            </span>
          </span>
        )}
      </button>

      {/* 上传进度。只有真的在传的时候才出现 —— 0% 常驻会让人以为卡住了 */}
      {progress !== null && (
        <div className="mt-2" aria-live="polite">
          <div className="h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
          <p className="mt-1 text-right text-[11px] text-muted tnum">{Math.round(progress)}%</p>
        </div>
      )}

      {error && <p className="mt-1.5 text-[11px] text-accent-soft">{error}</p>}

      {draft && !error && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted/70">
          这个指纹会上链。买家下载完之后可以自己算一遍跟链上对 ——
          对得上就证明拿到的东西一个字都没被改过。
        </p>
      )}
    </div>
  )
}
