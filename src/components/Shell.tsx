import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
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

/**
 * 买家壳 —— 付费页专用。
 *
 * **必须与控制台分开**,理由有二:
 *
 * ① 方案 §15 的 375px 移动优先**只对买家付款页成立**(开发计划 9/21 修正)。
 *    把付费页塞进 `AppShell` 的 `max-w-6xl` 里,手机上会得到一栏拉满、
 *    按钮宽到离谱的版面。
 * ② 买家不该看到「控制台 / 内容 / 收款」这几个创作者页签 ——
 *    那是另一个角色的导航,出现在付款页上只会让人犹豫"我是不是走错地方了"。
 *
 * 只留 logo 和连接钱包。顶栏刻意做得比控制台矮。
 */
export function BuyerShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line-soft bg-ink/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-md items-center gap-6 px-5">
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px_rgba(232,65,66,0.75)]" />
            <span className="text-[15px] font-semibold tracking-tight">SplitJar</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
              收钱罐
            </span>
          </Link>
          <div className="ml-auto">
            <ConnectButton variant="nav" />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-md px-5 pb-20 pt-7">{children}</main>
    </div>
  )
}

/**
 * 创作者页面的顶栏。
 *
 * 页签在 W3 从"死的占位"变成真链接 —— **只对已经有页面的才这么做**。
 * `Agent` 仍是灰的:它对应的 `/api/catalog` 是 W7,现在做成能点就是假按钮。
 * W1 里那句「不假装能点」的规矩继续有效,只是适用面缩小了。
 */
function TopNav() {
  const tabs = [
    { to: '/', label: '控制台', end: true },
    { to: '/create', label: '内容' },
    { to: '/dashboard', label: '收款' },
  ]
  const soon = { label: 'Agent', note: 'W7 起' }

  return (
    <header className="sticky top-0 z-50 border-b border-line-soft bg-ink/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-5 sm:px-8">
        <Link to="/" className="flex shrink-0 items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px_rgba(232,65,66,0.75)]" />
          <span className="text-[15px] font-semibold tracking-tight">SplitJar</span>
          <span className="hidden rounded-full border border-line px-2 py-0.5 text-[11px] text-muted sm:inline">
            收钱罐
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                isActive
                  ? 'rounded-lg bg-white/[0.06] px-3 py-1.5 text-sm text-neutral-100'
                  : 'rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:text-neutral-300'
              }
            >
              {t.label}
            </NavLink>
          ))}

          {/* 还没开工的,保持灰着并说明原因 —— 不做成能点的假页签 */}
          <span title={`${soon.note}开放`} className="cursor-not-allowed rounded-lg px-3 py-1.5 text-sm text-muted">
            {soon.label}
            <span className="ml-1.5 text-[10px] text-muted/60">{soon.note}</span>
          </span>
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
