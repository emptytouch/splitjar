import type { Hex } from 'viem'
import { explorerTx, shortHash } from '../lib/links'

/**
 * 交易状态面板的三块最小件 —— `Panel` / `Spinner` / `TxLink`。
 *
 * ## 为什么要抽这个文件(2026-09-23)
 *
 * 这三个函数在仓库里本来有**多份逐字重复的拷贝**:`Panel` 在
 * `ClaimPending` 和 `PayStatus` 各一份,`Spinner` 在 `ClaimPending`、
 * `PayStatus`、`FilePick`、`UnlockButton` 各一份,`TxLink` 在
 * `ClaimPending` 和 `PayStatus` 各一份。
 *
 * 加「上下架」开关时又要用这三样 —— 往下再抄第四份显然不对。抽出来,
 * 新的组件直接用,`ClaimPending` 一并改过来(它那份与这里逐字相同)。
 *
 * ⚠️ `PayStatus` 那份 `Panel` **暂时没动**:它的 DOM 结构略有不同
 * (内部包了一层 `BOX` 常量、`title` 是必填的),合并它要改动一个已经
 * 验过的组件,不该和"加一个新功能"混在同一次改动里。留作打磨项,
 * 记在开发计划 §十二。
 *
 * ## 配色是有语义的,别随手换
 *
 * - `work` —— 进行中(预演 / 等钱包 / 等上链)
 * - `warn` —— **不是这个产品的错**,用户也做不了什么(比如代币侧被拉黑)
 * - `bad`  —— 这次操作失败了
 * - `good` —— 成功
 *
 * 成功一律配 `✓`,和 `PayStatus` / `ClaimPending` 保持一致 —— 用户是靠
 * 这个符号认"到底成没成"的。
 */
export function Panel({
  tone,
  title,
  children,
}: {
  tone: 'work' | 'warn' | 'bad' | 'good'
  /** 可选。`ClaimPending` 把标题写进 children 里,`PayStatus` 单独传 */
  title?: React.ReactNode
  children?: React.ReactNode
}) {
  const tones = {
    work: 'border-line bg-surface-2/60',
    warn: 'border-amber-400/30 bg-amber-400/[0.06]',
    bad: 'border-accent/35 bg-accent/[0.07]',
    good: 'border-emerald-400/30 bg-emerald-400/[0.06]',
  } as const

  return (
    <div className={`mt-3 rounded-xl border px-4 py-3.5 text-sm leading-relaxed ${tones[tone]}`}>
      {title}
      {children}
    </div>
  )
}

export function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent"
      role="status"
      aria-label="处理中"
    />
  )
}

export function TxLink({ hash }: { hash: Hex }) {
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-line underline-offset-2 hover:decoration-accent"
    >
      <span className="font-mono tnum">{shortHash(hash)}</span>
    </a>
  )
}
