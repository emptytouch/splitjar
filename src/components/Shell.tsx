import type { ReactNode } from 'react'
import { ConnectButton } from './ConnectButton'

/**
 * 桌面应用壳:顶部导航 + 宽内容区。
 * 窄屏自动塌成单列 —— 桌面是主场景,移动端是"能用"(方案 §15 的 375px 要求
 * 只对**买家扫码付款页**继续成立,那是买家真的在用手机)。
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <TopNav />
      <main className="mx-auto w-full max-w-6xl px-5 pb-24 pt-10 sm:px-8 lg:pt-14">
        {children}
      </main>
    </div>
  )
}

function TopNav() {
  // W3/W7 之前的占位页签。**不假装能点** —— 灰着并给出为什么
  const nav: Array<{ label: string; active?: boolean; soon?: string }> = [
    { label: '控制台', active: true },
    { label: '内容', soon: 'W3 起' },
    { label: '收款', soon: 'W3 起' },
    { label: 'Agent', soon: 'W7 起' },
  ]

  return (
    <header className="sticky top-0 z-50 border-b border-line-soft bg-ink/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-5 sm:px-8">
        <a href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px_rgba(232,65,66,0.75)]" />
          <span className="text-[15px] font-semibold tracking-tight">SplitJar</span>
          <span className="hidden rounded-full border border-line px-2 py-0.5 text-[11px] text-muted sm:inline">
            收钱罐
          </span>
        </a>

        <nav className="hidden items-center gap-1 md:flex">
          {nav.map((n) => (
            <span
              key={n.label}
              title={n.soon ? `${n.soon}开放` : undefined}
              className={
                n.active
                  ? 'rounded-lg bg-white/[0.06] px-3 py-1.5 text-sm text-neutral-100'
                  : 'cursor-not-allowed rounded-lg px-3 py-1.5 text-sm text-muted'
              }
            >
              {n.label}
              {n.soon && <span className="ml-1.5 text-[10px] text-muted/60">{n.soon}</span>}
            </span>
          ))}
        </nav>

        <div className="ml-auto">
          <ConnectButton variant="nav" />
        </div>
      </div>
    </header>
  )
}

export function PageHeader({
  title,
  subtitle,
  badge,
}: {
  title: string
  subtitle: ReactNode
  badge?: ReactNode
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:mb-10 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted">{subtitle}</p>
      </div>
      {badge}
    </div>
  )
}

export function Card({
  title,
  hint,
  action,
  children,
  className = '',
}: {
  title?: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`flex flex-col rounded-2xl border border-line bg-surface/70 p-5 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset] sm:p-6 ${className}`}
    >
      {title && (
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium tracking-tight text-neutral-100">{title}</h2>
            {hint && <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

/**
 * 未开工的功能位 —— 明确标出属于哪个工作包,不做成能点的假按钮。
 *
 * `flex-1` 而不是 `h-full`:卡片在网格里会被拉伸到和邻居一样高,
 * 此时 `height:100%` 是拿**父元素的 padding box** 算的,会比真正的内容区
 * 高出「padding + 标题」那一截,虚线框就戳出卡片外面去了。
 */
export function Placeholder({ note }: { note: string }) {
  return (
    <div className="flex min-h-[132px] flex-1 items-center justify-center rounded-xl border border-dashed border-line px-4 py-6 text-center">
      <p className="text-xs leading-relaxed text-muted">{note}</p>
    </div>
  )
}
