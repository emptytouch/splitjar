import { useRef } from 'react'
import type { Hex } from 'viem'
import { PreviewPanel } from './PreviewPanel'
import { Panel, Spinner } from './TxPanel'
import { usePreviewBackfill } from '../hooks/usePreviewBackfill'
import {
  BACKFILL_DONE_COPY,
  BACKFILL_STEP_COPY,
  HASH_UNVERIFIED_NOTE,
  canSubmit,
  describeBackfillFailure,
  isBackfillBusy,
  type BackfillRecovery,
  type BackfillState,
} from '../lib/backfillMachine'

/**
 * 「补预览图」—— 内容看板里每一行上的收尾入口。
 *
 * ## 它补的是一个**看得见却没有出口**的状态
 *
 * 发布时预览图上传失败**不挡发布**(理由见 `lib/previewDerive.ts`),
 * 于是存在一种内容:链上好好的、买家买得到、广场上那一格却是空的。
 * 在那个失败里我们给用户的承诺是"补预览图的入口在内容看板" ——
 * 这个组件就是那句话的兑现。**没有它,那句话是空的。**
 *
 * ## ⚠️ 位置:必须是 `<li>` 的直接子元素,不能在调用方的 flex 行里
 *
 * 与 `ActiveToggle` 完全同一个理由:它除了按钮还有一个会占满宽度的
 * 状态面板。塞进 flex 行里,面板会变成同一行的第二个 flex item,
 * 被挤成窄窄一条,里面的解释文字会烂掉。
 *
 * ## ⚠️ 为什么必须先让创作者**看见**那张图再决定传(两段式)
 *
 * 选完文件**不自动上传** —— 中间多一个 `ready` 状态,把派生出来的那张图
 * 原样摆在创作者面前,由他点「确认上传」。
 *
 * 判据来自 `PreviewPanel` 自己的文件头:**这张图会公开在广场上,
 * 任何人拿到直链都能存下来。让一个人把一张自己没见过的图公开出去,
 * 是说不通的。** `/create` 那条路就是这么做的(选完文件立刻显示预览图),
 * 补图这条没有理由更宽松 —— 而且这里更该谨慎:补图时他手上那个文件
 * **是不是原件本身就需要他自己确认**。
 */
export function PreviewBackfill({
  contentId,
  contentHash,
  onUploaded,
}: {
  contentId: Hex
  /** 链上记的内容指纹。零值 = 核对不了,见 shared/contentHash.ts */
  contentHash: Hex | null
  /** 传成功之后调用 —— 由调用方重新拉那份预览图列表 */
  onUploaded: () => void
}) {
  const { state, progress, pick, submit, reset } = usePreviewBackfill({
    contentId,
    contentHash,
    onUploaded,
  })

  const input = useRef<HTMLInputElement>(null)
  const busy = isBackfillBusy(state)
  // id 要唯一 —— 这是逐行渲染的,页面上会有多个同名的 input
  const inputId = `preview-file-${contentId}`

  /**
   * ⚠️ `done` 之后按钮要**禁掉**,不是换个文案继续让点。
   *
   * 预览图这时候已经在公开 store 里了,同一条 pathname 再写一次会被平台的
   * `allowOverwrite: false` 拒掉 —— 而那个拒绝理由到不了前端(见
   * `usePreviews` 文件头)。一个点了必然失败、理由还说不清的按钮,
   * 不如一开始就不能点。
   */
  const canPick = !busy && state.k !== 'done'

  return (
    <>
      <div className="mt-3 flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-soft pt-3">
        <p className="min-w-0 text-[11px] leading-relaxed text-muted">
          广场上这一件没有缩略图 —— 不影响买卖,只是买家不好认。
        </p>

        {/*
          真正的 input 藏起来 —— 原生控件没法跟这套视觉一致。
          ⚠️ **不能用 `display:none`**:那样它连键盘和读屏都摸不到。
          `sr-only` 保留可聚焦性,下面那个按钮负责唤起它
        */}
        <input
          ref={input}
          id={inputId}
          type="file"
          className="sr-only"
          disabled={!canPick}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void pick(f)
            // 清空 value,**否则选同一个文件第二次不会触发 change** ——
            // 指纹对不上想重选同一个文件时会发现"点了没反应"(同 FilePick)
            e.target.value = ''
          }}
        />

        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={!canPick}
          className="shrink-0 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-200 transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.k === 'idle' || state.k === 'checking' ? '补预览图' : '换一个文件'}
        </button>
      </div>

      <BackfillPanel state={state} progress={progress} onSubmit={submit} onReset={reset} />
    </>
  )
}

/**
 * 状态 → 面板。
 *
 * 与 `ActivePanel` 同一个分工:**状态机决定给什么出路,组件只负责画**。
 * `recovery` 到按钮的那一步映射在下面的 `RecoveryButton` 里,只有一处。
 */
function BackfillPanel({
  state,
  progress,
  onSubmit,
  onReset,
}: {
  state: BackfillState
  progress: number | null
  onSubmit: () => void
  onReset: () => void
}) {
  switch (state.k) {
    case 'idle':
      return null

    case 'checking':
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            {BACKFILL_STEP_COPY.checking.title}
          </span>
          <p className="mt-1.5 text-xs text-muted">
            {BACKFILL_STEP_COPY.checking.hint}这一步不碰钱包,也不会传出任何东西。
          </p>
        </Panel>
      )

    case 'working': {
      const copy = BACKFILL_STEP_COPY[state.step]
      return (
        <Panel tone="work">
          <span className="flex items-center gap-2.5 text-neutral-100">
            <Spinner />
            {copy.title}
          </span>
          <p className="mt-1.5 text-xs text-muted">{copy.hint}</p>
          {/* 进度条只在真在传的时候有意义 —— `authorizing` 那一步没有字节在动 */}
          {state.step === 'uploading' && progress !== null && (
            <div className="mt-2.5" aria-live="polite">
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
              <p className="mt-1 text-right text-[11px] text-muted tnum">
                {Math.round(progress)}%
              </p>
            </div>
          )}
        </Panel>
      )
    }

    case 'ready':
      return (
        <>
          {/*
            ⚠️ 复用 `/create` 那个面板,不另写一套。它已经把两件必须说的话
            说全了:这张图**会公开**,以及水印是真打上去的。
            照抄一份到这里的必然结局是两份文案漂移

            ⚠️ `max-w-md` 是**在调用点收的宽**,不是改 `PreviewPanel`
            —— 它的图是 `w-full`,在 `/create` 那个窄栏里合适;而这里是
            列表行的整行宽度(桌面约 1000px),不收的话一张 900px 的图会把
            这一行撑到别的行都没法看。宽度是**上下文**的事,
            所以约束留在上下文这一侧(同一条纪律见 `ActiveToggle` 的位置)。
          */}
          <div className="mt-3 max-w-md">
            <PreviewPanel derivation={state.preview} />
          </div>

          {!state.hashVerified && (
            <Panel tone="warn">
              <p className="text-xs leading-relaxed text-muted">{HASH_UNVERIFIED_NOTE}</p>
            </Panel>
          )}

          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit(state)}
            className="mt-3 w-full rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            确认上传
          </button>
        </>
      )

    case 'no-preview':
      /**
       * ⚠️ **不是报错框。** 这条路是"这类文件本来就没有画面可取"
       * —— PDF、压缩包、音频。用红色报错显示它,创作者会以为自己做错了
       * 什么,然后去找一张根本不需要的图(与 `PreviewPanel` 同一条纪律)。
       */
      return (
        <Panel tone="warn">
          <p className="text-xs leading-relaxed text-muted">
            这个文件派生不出预览图 —— 这类文件没有画面可以取,和发布时是同一个结论。
            这一件在广场上就保持没有缩略图,不影响买卖。
          </p>
          <button
            type="button"
            onClick={onReset}
            className="mt-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent hover:text-neutral-50"
          >
            知道了
          </button>
        </Panel>
      )

    case 'done':
      return (
        <Panel tone="good">
          <span className="text-emerald-400">{BACKFILL_DONE_COPY.title}</span>
          <p className="mt-1.5 text-xs text-muted">{BACKFILL_DONE_COPY.hint}</p>
        </Panel>
      )

    case 'failed': {
      const d = describeBackfillFailure(state.reason)
      return (
        <Panel tone={d.tone}>
          {d.title}
          {d.hint && <p className="mt-1.5 text-xs leading-relaxed text-muted">{d.hint}</p>}
          {state.detail && (
            <p className="mt-2 font-mono text-[11px] break-all text-muted/70">{state.detail}</p>
          )}
          <RecoveryButton recovery={d.recovery} onRetry={onSubmit} onReset={onReset} />
        </Panel>
      )
    }

    default: {
      const never: never = state
      return never
    }
  }
}

/** 状态机给的出路 → 一个按钮。分工见 `describeBackfillFailure` 上方那段 */
function RecoveryButton({
  recovery,
  onRetry,
  onReset,
}: {
  recovery: BackfillRecovery
  onRetry: () => void
  onReset: () => void
}) {
  switch (recovery.k) {
    case 'retry':
      return (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent hover:text-neutral-50"
        >
          重试
        </button>
      )

    case 'repick':
      // ⚠️ 这里**不是**"重试" —— 手上那张图已经被证明是错的(或者是空的、
      // 读不出的),重试只会拿同一张错的图再试一遍。真正的出路是重新选文件
      return (
        <button
          type="button"
          onClick={onReset}
          className="mt-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent hover:text-neutral-50"
        >
          换一个文件
        </button>
      )

    case 'dismiss':
      return (
        <button
          type="button"
          onClick={onReset}
          className="mt-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent hover:text-neutral-50"
        >
          知道了
        </button>
      )

    default: {
      const never: never = recovery
      return never
    }
  }
}
