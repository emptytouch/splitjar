import { Link } from 'react-router-dom'
import { useAccount, useReadContract } from 'wagmi'
import { Card, PageHeader } from '../components/Shell'
import { ConnectButton } from '../components/ConnectButton'
import { ClaimPending } from '../components/ClaimPending'
import { ActiveToggle } from '../components/ActiveToggle'
import { PreviewBackfill } from '../components/PreviewBackfill'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { explorerTx, shortAddress, shortHash } from '../lib/links'
import { formatUsdc } from '../../shared/units'
import { titleText, type RowTitle } from '../lib/contentMeta'
import { useMyContents } from '../hooks/useMyContents'
import { usePreviews } from '../hooks/usePreviews'
import { AGENT_ENTRIES } from '../../shared/agentAddresses'

/**
 * `/dashboard` —— 收入看板 + **我的内容**(含上下架)。
 *
 * 上游范围:「`getLogs` 按 creator + 合约地址过滤」。方案 §10 的方案 A
 * (MVP 零额外基建):前端直接 `getLogs` 渲染,不依赖任何索引器。
 *
 * ## 数据查询已经搬走了
 *
 * 2026-09-23 起,这一页的数据不再自己查 —— 抽到了 `hooks/useMyContents.ts`,
 * 因为控制台(`/`)要显示同一份内容的摘要(开发计划 §12.2)。
 * **一个判断写两遍必然漂移**,所以两个页面共用同一个 hook(同一个 `queryKey`,
 * react-query 自己去重,从控制台点过来不会重扫一遍链)。
 *
 * ## 上下架开关也是在这一页
 *
 * 方案 §5.1 要求创作者可 `setContentActive(contentId, false)`,但此前
 * **全仓库零调用点** —— 内容一旦创建就永远无法下架。开关放在这里而不是
 * 控制台,是因为**列表在这里**:上下架天然长在每一行上,不需要新路由,
 * 也不用动已冻结的 §8.1 接口。
 *
 * ⚠️ 配套改动:`payGate.ts` 里归属判断必须排在下架判断**之前**,否则
 * 买过的人在下架后会失去下载入口 —— 那正好违反"下架不影响已购"这条语义。
 * 两处是一件事的两半,见 `ActiveToggle` 文件头。
 *
 * ## 2026-09-25:「补预览图」也长在这一行上
 *
 * 和上下架同一个理由 —— **列表在这里**,所以"这一件缺什么"的入口也该在这里。
 *
 * 它收的是发布流程留下的一个尾巴:预览图上传失败**不挡发布**(内容已经在
 * 存储里了,见 `lib/previewDerive.ts`),于是会存在一种内容 —— 链上好好的、
 * 买家买得到、广场上那一格却是空的,而创作者**没有任何入口去补**。
 * `/create` 在那个失败里给的承诺("入口在内容看板")就是靠这一行兑现的。
 *
 * ⚠️ 判据来自 `GET /api/previews`(公开 store 的读侧),**不是链上** ——
 * 链上不存预览图。而且它有三态,"不知道"时**什么都不画**,
 * 见 `hooks/usePreviews.ts` 文件头。
 */
export function DashboardPage() {
  const { address, isConnected } = useAccount()
  const query = useMyContents()
  /**
   * 哪些内容在广场上有缩略图。
   *
   * ⚠️ `urls === null` 是**"不知道"**,不是"都没有" —— 见 `usePreviews`
   * 文件头。那一整段讲的都是"为什么不知道时什么都不能画",别在这里
   * 图省事写成 `urls?.has(id) ?? false`。
   */
  const previews = usePreviews()

  // 待提取余额(W4 的 withdraw 全链路在那一版做,这里只如实显示)
  const pending = useReadContract({
    abi: creatorSplitterAbi,
    address: SPLITTER_ADDRESS,
    functionName: 'pendingBalance',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  })

  const rows = query.rows
  const times = query.times
  const totalEarned = rows.reduce((a, r) => a + r.earned, 0n)
  const totalSales = rows.reduce((a, r) => a + r.sales.length, 0)
  const delisted = rows.filter((r) => !r.active).length

  return (
    <>
      <PageHeader
        title="收款"
        subtitle={
          <>
            每一笔都直接读链上的 <code className="text-neutral-300">PaymentSplit</code> 事件 ——
            <span className="text-neutral-300">没有自己的数据库</span>,也就没有"看板和对不上"的可能。
          </>
        }
      />

      {!isConnected ? (
        <Card title="先连接钱包" hint="看板按创建者地址过滤,所以要先知道你是谁">
          <ConnectButton variant="block" />
        </Card>
      ) : (
        <div className="space-y-5">
          {/* ── 汇总 ─────────────────────────────────────────── */}
          <div className="grid gap-5 sm:grid-cols-3">
            <Card title="累计收入">
              <p className="font-mono tnum text-2xl font-semibold">
                {formatUsdc(totalEarned)}
                <span className="ml-1.5 text-xs font-normal text-muted">USDC</span>
              </p>
              <p className="mt-1.5 text-[11px] text-muted">只统计进入你的份额</p>
            </Card>
            <Card title="成交笔数">
              <p className="font-mono tnum text-2xl font-semibold">{totalSales}</p>
              <p className="mt-1.5 text-[11px] text-muted">链上事件计数</p>
            </Card>
            <Card
              title="待提取"
              hint="按当前连上的钱包查 pendingBalance —— 协作者连上时看到的是他自己那份"
            >
              <ClaimPending
                amount={pending.data ?? 0n}
                onClaimed={() => void pending.refetch()}
              />
            </Card>
          </div>

          {/* ── 我的内容 ─────────────────────────────────────── */}
          <Card
            title="我的内容"
            hint={
              delisted > 0
                ? `按 ContentRegistered 事件里的 creator 过滤 · ${delisted} 件已下架`
                : '按 ContentRegistered 事件里的 creator 过滤 —— 这是链上事实'
            }
            action={
              <button
                type="button"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
                className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-300 transition-colors hover:border-accent disabled:opacity-50"
              >
                {query.isFetching ? '刷新中…' : '刷新'}
              </button>
            }
          >
            {query.isLoading ? (
              <div className="animate-pulse space-y-3" aria-busy="true">
                <div className="h-14 rounded-xl bg-surface-2" />
                <div className="h-14 rounded-xl bg-surface-2" />
              </div>
            ) : query.isError ? (
              <div className="rounded-xl border border-accent/35 bg-accent/[0.07] px-4 py-3">
                <p className="text-sm text-neutral-100">读链失败</p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">
                  网络繁忙,{/* 方案 §14.2:不得显示成"没有数据" */}这不代表你没有内容 ——
                  点上面的刷新重试。
                </p>
              </div>
            ) : rows.length === 0 ? (
              /* 方案 §14.2:「空看板:无订单时给引导而非空白」 */
              <div className="rounded-xl border border-dashed border-line px-5 py-10 text-center">
                <p className="text-sm text-neutral-300">还没有创建过内容</p>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
                  创建一件付费内容之后,买家每付一笔,这里就会立刻多一行 ——
                  数据来自链上事件,不需要任何同步。
                </p>
                <Link
                  to="/create"
                  className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-soft"
                >
                  创建第一件内容
                </Link>
              </div>
            ) : (
              <ul className="space-y-4">
                {rows.map((r) => (
                  <li key={r.contentId} className="rounded-xl border border-line-soft bg-surface-2/40 p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-100">
                          <span className="truncate">
                            <RowTitleText title={r.title} />
                          </span>
                          {/*
                            已下架的状态必须比标题更早被看到 —— 否则创作者会疑惑
                            "为什么没人买"。方案 §14.2 要求买家侧显示"已下架",
                            创作者侧同理:他自己也得知道。
                          */}
                          {!r.active && <StatusBadge label="已下架" tone="warn" />}
                        </p>
                        <Link
                          to={sharePath(r.contentId, r.title)}
                          className="font-mono text-[11px] text-muted underline decoration-line underline-offset-2 hover:decoration-accent"
                        >
                          {r.contentId.slice(0, 18)}…
                        </Link>
                      </div>
                      <div className="text-right">
                        <p className="font-mono tnum text-sm text-neutral-100">
                          {formatUsdc(r.earned)} USDC
                        </p>
                        <p className="text-[11px] text-muted">
                          定价 {formatUsdc(r.price)} · {r.sales.length} 笔
                        </p>
                      </div>
                    </div>

                    {/*
                      ⚠️ 直接子元素,不能在 flex 行里 —— 它内部除了按钮还有一个
                      会占满宽度的状态说明面板。理由见 `ActiveToggle` 的注释。
                    */}
                    <ActiveToggle
                      contentId={r.contentId}
                      active={r.active}
                      onChanged={() => void query.refetch()}
                    />

                    {/*
                      ⚠️ **只在"确实没有"时画这个入口。**
                      `previews.urls === null` 是"不知道"(还没拉到 / 读失败 /
                      服务端没配公开 store)—— 那时候什么都不画。当成"没有"
                      会让创作者在一个根本不缺缩略图的内容上白签一次名,
                      然后收到一句说不清理由的失败(详见 `usePreviews` 文件头)。

                      键一律**小写**:服务端写入时统一过 `toLowerCase()`,
                      catalog 那边也是这么查的。少一次归一化就是"明明有、
                      却查不到"。
                    */}
                    {previews.urls !== null && !previews.urls.has(r.contentId.toLowerCase()) && (
                      <PreviewBackfill
                        contentId={r.contentId}
                        contentHash={r.contentHash}
                        onUploaded={() => void previews.refetch()}
                      />
                    )}

                    {r.sales.length > 0 && (
                      <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-3">
                        {r.sales.map((s) => (
                          <li
                            key={`${s.txHash}-${s.payer}`}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]"
                          >
                            <span className="flex items-baseline gap-2 text-muted">
                              <span className="text-emerald-400">+{formatUsdc(s.myShare)}</span>
                              <a
                                href={explorerTx(s.txHash)}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono underline decoration-line underline-offset-2 hover:decoration-accent"
                              >
                                {shortHash(s.txHash, 6, 4)}
                              </a>
                              <span className="font-mono">来自 {shortAddress(s.payer)}</span>
                              {/*
                                ⚠️ 徽章只在 `isAgent` 为真时出现 —— 判定在
                                `useMyContents` 里做(白名单只有一个定义处),
                                这一页**不做任何地址比较**。见 shared/agentAddresses.ts。
                              */}
                              {s.isAgent && <StatusBadge label="Agent" tone="agent" />}
                            </span>
                            <span className="text-muted/70">
                              {times.get(String(s.blockNumber))?.toLocaleString('zh-CN') ?? `块 ${s.blockNumber}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-[11px] leading-relaxed text-muted/70">
            时间取自区块时间戳;取不到的显示区块号。
            <br />
            <span className="text-muted">[Agent] 标记按地址白名单判定,不是自动识别。</span>{' '}
            链上两条路走的是同一个 <code>pay(bytes32)</code> 和同一个{' '}
            <code>PaymentSplit</code> 事件,而且 <code>msg.sender</code> 就是买家本人
            —— 本来就没有可识别的痕迹,是谁只能靠登记。
            {AGENT_ENTRIES.length === 0 ? (
              <> 名单现在是空的:还没有地址被登记为 agent,所以没人会被标上。</>
            ) : (
              <>
                {' '}名单:{' '}
                {AGENT_ENTRIES.map((e, i) => (
                  <span key={e.address}>
                    {i > 0 && '、'}
                    <span className="font-mono">{shortAddress(e.address)}</span>
                    {e.label && `(${e.label})`}
                  </span>
                ))}
              </>
            )}
          </p>
        </div>
      )}
    </>
  )
}

/**
 * 标题位 —— **四态各画各的**。
 *
 * ⚠️ 这里最容易写错的是把那三态压成一句兜底:写成 `r.title || '未命名内容'`
 * 就等于**替服务端断言"这件内容没有标题"**,而其中有一态明明只是
 * "我们没读到"。方案 §14.2 禁止把读失败画成没有数据 —— 同一条纪律
 * 在 `ExplorePage`(读链失败 vs 没有内容)和 `usePreviews`(不知道 vs 没有)
 * 各出现过一次,这里是第三次。
 */
function RowTitleText({ title }: { title: RowTitle }) {
  switch (title.k) {
    case 'server':
    case 'local':
      return <>{title.text}</>

    // 服务端读到了、它说没有 —— 这一句是**真的**,可以画
    case 'none':
      return <span className="text-muted">未命名内容</span>

    /**
     * ⚠️ 服务端那份还在路上。**给一块占位,不给一句话** ——
     * 写「未命名内容」或「读不到」都会在半秒后被真标题打脸,
     * 而"这一页会自己改口"比多等半秒糟。
     *
     * ⚠️ 底色用 `bg-line` 而**不是**列表骨架那块 `bg-surface-2`:
     * 这一块落在行底 `bg-surface-2/40` 上,两个同族灰叠起来在截图里
     * **几乎看不见**(2026-09-26 实拍确认)。看不见的占位和"坏了"长得一样,
     * 而这一态**是本机开发时最常见的那一态** —— `/api/catalog` 要在服务端扫链,
     * 实测本机 **5.5~12.9 秒**(线上约 0.7 秒)。⚠️ 别拿本机那个数字当线上行为:
     * 本机 dev 的函数进程不带代理时还会更慢甚至 503,那是环境,不是这个端点。
     *
     * 时长不是重点,**占位块必须看得见才是** —— 换成别的机器/别的网络,
     * 这个"还在路上"的窗口照样存在。
     */
    case 'pending':
      return (
        <span
          className="inline-block h-3.5 w-24 animate-pulse rounded bg-line align-middle"
          aria-label="标题载入中"
        />
      )

    // 读失败,或者它不在服务端那份列表里(下架的内容不在目录里)
    case 'unknown':
      return (
        <span
          className="text-muted/70"
          title="标题存在服务端的目录里,这一页现在读不到它 —— 内容本身不受影响"
        >
          标题读不到
        </span>
      )

    default: {
      const never: never = title
      return never
    }
  }
}

/**
 * 分享链接。
 *
 * ⚠️ `?t=` 只在**真拿到了标题**时才加(`titleText` 给不出就是 `null`)——
 * 拼一个空的 `?t=` 进去,那条链接就与"没有标题"的链接长得不一样了,
 * 而两者对买家是同一件事。
 */
function sharePath(contentId: string, title: RowTitle): string {
  const t = titleText(title)
  return `/p/${contentId}${t ? `?${new URLSearchParams({ t })}` : ''}`
}

/** 行内状态小标签 */
function StatusBadge({ label, tone }: { label: string; tone: 'warn' | 'agent' }) {
  const tones = {
    warn: 'border-amber-400/35 bg-amber-400/[0.08] text-amber-300/90',
    // 用主办方的红当 accent,和「已下架」的琥珀色拉开 —— 这两个标签会同时出现
    agent: 'border-accent/40 bg-accent/[0.09] text-accent-soft',
  } as const

  return (
    <span
      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-normal ${tones[tone]}`}
    >
      {label}
    </span>
  )
}
