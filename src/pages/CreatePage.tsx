import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { isAddress, type Hex } from 'viem'
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { Card, PageHeader } from '../components/Shell'
import { ShareQr } from '../components/ShareQr'
import { ConnectButton } from '../components/ConnectButton'
import { CHAIN } from '../../shared/chain'
import { buildShareUrl, normalizeTitle, rememberContent, TITLE_MAX } from '../lib/contentMeta'
import { explorerTx, shortHash } from '../lib/links'
import { classifyError, shortReason } from '../lib/payErrors'
import { describeFailure, type FailReason } from '../lib/payMachine'
import { SPLITTER_ADDRESS, creatorSplitterAbi, generateContentId } from '../lib/splitter'
import {
  AmountError,
  formatBps,
  formatUsdc,
  parseBps,
  parseUsdc,
  previewShares,
} from '../lib/units'

/**
 * `/create` —— W4:分账比例可编辑,支持多位协作者。
 *
 * ## W3 用的是"让错误不可表示",W4 起必须放开
 *
 * W3 只有一个比例输入框:我填我的比例,协作者拿剩下的 —— **合计恒为 100%,填不错**。
 * 那是 2 方才有的特权。
 *
 * 3 方起做不到:三个独立的比例,结构上就可能填出 90% 或 110%。而方案 §16.1 的验收项
 * 恰恰是「创作者能创建一个 3 方分账商品,**`splits` 合计非 100% 时被前端拦下**」——
 * 它要的是"拦下"这个**动作**。单输入框在结构上填不出非 100%,这条验收就永远无法被证明。
 *
 * 所以这里**故意**让用户能填错,再当场拦下来。这是本版少数"为了可验收而牺牲一点
 * 设计纯度"的地方 —— 记在这里,免得后来的人以为是退化。
 *
 * ## 前端不该比合约更严
 *
 * 合约(`createContent`)只校验:每项 > 0、合计 == 10000、地址非零、长度一致。
 * 它**不禁止**重复地址,也不禁止把创作者自己写进 recipients ——
 * `recipients = [A, A, B]` 在合约层面就是"A 拿两份",完全合法(同一个人的两个角色)。
 *
 * 所以这里对这两条**只警告、不拦截**。凭空加一条合约没有的规则,会抹掉一个真实用法。
 * 只有验收项点名要求的"合计 100%",才拦死。
 */

/**
 * 收款方数量上限。
 *
 * 方案 §12.2 的论证是"3 方、5 方、10 方都可行",这里就守那个 10。
 * 给 UI 一个上界,防手滑点出几十行 —— 而每多一方,付款的 gas 就线性涨一点。
 */
const MAX_RECIPIENTS = 10

type CreateState =
  | { k: 'editing' }
  | { k: 'signing' }
  | { k: 'pending'; hash: Hex }
  | { k: 'done'; contentId: Hex; hash: Hex }
  | { k: 'failed'; reason: FailReason; detail?: string }

type Action =
  | { type: 'sign' }
  | { type: 'sent'; hash: Hex }
  | { type: 'done'; contentId: Hex; hash: Hex }
  | { type: 'fail'; reason: FailReason; detail?: string }
  | { type: 'reset' }

function reducer(state: CreateState, action: Action): CreateState {
  switch (action.type) {
    case 'sign':
      return { k: 'signing' }
    case 'sent':
      return { k: 'pending', hash: action.hash }
    case 'done':
      return { k: 'done', contentId: action.contentId, hash: action.hash }
    case 'fail':
      // 只从"进行中"落到失败 —— 迟到的回调不该覆盖已完成的界面
      return state.k === 'signing' || state.k === 'pending'
        ? { k: 'failed', reason: action.reason, detail: action.detail }
        : state
    case 'reset':
      return { k: 'editing' }
    default: {
      const never: never = action
      return never
    }
  }
}

/**
 * 一位协作者。
 *
 * ⚠️ `id` 是**稳定的自增 id,不能改用数组下标当 React key**。
 * 删掉中间一行时,下标会让后面所有行的 key 整体前移,React 于是复用错组件 ——
 * 表现是剩下输入框里的值"错位到别人身上"。**分账地址错了就是钱错了。**
 */
type Row = { id: number; addr: string; pct: string }

const INPUT =
  'w-full rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5 text-sm text-neutral-100 outline-none transition-colors placeholder:text-muted/60 focus:border-accent'
const LABEL = 'mb-1.5 block text-xs text-muted'
// 右侧留出位置给那个「%」—— 光看「70」要猜单位,而分账比例的 70 和 0.7 差 100 倍
const PCT_INPUT =
  'w-full rounded-xl border border-line bg-surface-2/60 py-2.5 pl-3 pr-7 text-right font-mono tnum text-sm text-neutral-100 outline-none transition-colors placeholder:text-muted/60 focus:border-accent'

/** 比例输入框里那个「%」。放进框内而不是框外,这样它跟着框一起动、也不会被误点 */
function PctSuffix() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted"
    >
      %
    </span>
  )
}

export function CreatePage() {
  const { address, isConnected, chainId } = useAccount()
  const [state, dispatch] = useReducer(reducer, { k: 'editing' })

  const [title, setTitle] = useState('')
  const [price, setPrice] = useState('0.2')
  const [myPct, setMyPct] = useState('70')

  // 默认 70 / 20 / 10 —— 方案 §5 的功能清单和 §3 的用户故事都是这个配置,不是随手定的
  const [rows, setRows] = useState<Row[]>([
    { id: 1, addr: '', pct: '20' },
    { id: 2, addr: '', pct: '10' },
  ])
  const nextRowId = useRef(3)

  // 生成一次就固定住 —— 重试时**必须复用同一个 id**,
  // 否则每次点重试都是一个新内容,用户会以为创建了多件
  const contentId = useMemo(() => generateContentId(), [])
  const fired = useRef(false)

  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })

  // ── 表单校验。全部走字符串,不做浮点往返(见 lib/units.ts)──────────
  //
  // 返回的 `errors` 用**扁平字符串键**而不是嵌套结构,因为要直接喂给 `shown()`:
  // 每个输入框在失焦后取自己的那条错误。`row:${id}:addr` 这种键同时也是稳定的。
  const parsed = useMemo(() => {
    const errors: Record<string, string> = {}

    const t = normalizeTitle(title)
    if (!t) errors.title = '标题不能为空 —— 分享链接靠它告诉买家买的是什么'

    let priceWei: bigint | null = null
    try {
      priceWei = parseUsdc(price)
      if (priceWei <= 0n) errors.price = '价格必须大于 0'
    } catch (e) {
      errors.price = e instanceof AmountError ? e.message : '价格格式不对'
    }

    let myBps: number | null = null
    try {
      myBps = parseBps(myPct)
      if (myBps <= 0 || myBps > 10000) errors.myPct = '比例要在 0% 到 100% 之间'
    } catch (e) {
      errors.myPct = e instanceof AmountError ? e.message : '比例格式不对'
    }

    // 逐行校验协作者。空行不算"填错",算"还没填" —— 错误照样记,
    // 但显示与否由 touched 决定(见下方 shown)
    const rowBps: (number | null)[] = []
    for (const r of rows) {
      const a = r.addr.trim()
      if (!a) errors[`row:${r.id}:addr`] = '填一个收款地址'
      else if (!isAddress(a)) errors[`row:${r.id}:addr`] = '不是一个合法的以太坊地址'

      let bps: number | null = null
      try {
        bps = parseBps(r.pct)
        if (bps <= 0) errors[`row:${r.id}:pct`] = '比例必须大于 0'
      } catch (e) {
        errors[`row:${r.id}:pct`] = e instanceof AmountError ? e.message : '比例格式不对'
      }
      rowBps.push(bps)
    }

    // ── 合计。这是 §16.1 点名要拦的那一条 ─────────────────────────
    // 只累加能解析出来的行;填不出来的行已经各自报错了,再算进合计只会让差额数字乱跳
    const total = [myBps, ...rowBps].reduce<number>((a, b) => a + (b ?? 0), 0)
    const sumOk = total === 10000
    if (!sumOk) {
      errors.sum =
        total < 10000
          ? `合计 ${formatBps(total)},还差 ${formatBps(10000 - total)}`
          : `合计 ${formatBps(total)},超了 ${formatBps(total - 10000)}`
    }

    const ok = Object.keys(errors).length === 0
    const recipients = ok ? ([address!, ...rows.map((r) => r.addr.trim())] as `0x${string}`[]) : []
    const splits = ok ? ([myBps!, ...(rowBps as number[])] as number[]) : []

    /**
     * 每一方实际能拿多少 —— **只在分账本身成立时算**,与标题、地址都无关。
     *
     * ⚠️ 这里不能用 `ok`:它把标题和地址也算进去了,于是"标题还没填"会让
     * 「实际到手多少」整块消失 —— 那是两个毫无关系的字段。第一版就是这么写的。
     * 而且合计不对时**必须不算**:那时按余数规则推出来的金额是假的
     * (链上会直接 revert),显示了反而误导。
     */
    const splitsReady = sumOk && myBps !== null && rowBps.every((b) => b !== null && b > 0)
    const amountPreview =
      splitsReady && priceWei !== null && priceWei > 0n
        ? previewShares(priceWei, [myBps!, ...(rowBps as number[])])
        : null

    // ── 只警告、不拦截的两条(合约本来就允许)─────────────────────
    //
    // ⚠️ 这里**不能**从上面那个 `recipients` 派生 —— 它只在 `ok` 时才有值,
    // 而合计填错的时候恰恰最需要看到重复地址的提示(账还没平,又叠一个地址重复)。
    // 第一版就是这么写的,被 drive-create3.mjs 的【6】抓出来了。
    const warnings: string[] = []
    const seen = [...(address ? [address] : []), ...rows.map((r) => r.addr.trim())]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
    if (new Set(seen).size !== seen.length) {
      warnings.push('有重复的收款地址 —— 合约允许,那个人会拿到两份。确认这是你想要的。')
    }
    if (address && rows.some((r) => r.addr.trim().toLowerCase() === address.toLowerCase())) {
      warnings.push('有一位协作者的地址就是你自己 —— 合约允许,你会拿到两份。')
    }

    return {
      errors,
      title: t,
      priceWei,
      myBps,
      rowBps,
      total,
      ok,
      recipients,
      splits,
      amountPreview,
      warnings,
    }
  }, [title, price, myPct, rows, address])

  const onFuji = isConnected && chainId === CHAIN.id
  const canSubmit = parsed.ok && onFuji && state.k !== 'signing' && state.k !== 'pending'

  /**
   * 字段「被碰过」之后才显示它的错误。
   *
   * 一进页面就飘红(「标题不能为空」)读起来像"你已经做错了" —— 可用户
   * 一个字都还没敲。校验本身一直照跑(`parsed.ok` 始终在拦提交),
   * 这里推迟的只是**显示**:失焦一次就算碰过,空着离开一个必填框,
   * 本来就该知道它是必填的。
   *
   * ⚠️ W4 加了行之后,这条规则同样适用于**新加的那一行**。
   * 新行如果没走 `shown`,一出现就报"填一个收款地址" —— 用户才刚点完"＋添加协作者",
   * 什么都没来得及做就被指责了一次。这是本工作包最容易重犯的错。
   */
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const markTouched = (field: string) =>
    setTouched((t) => (t[field] ? t : { ...t, [field]: true }))
  const shown = (field: string) => (touched[field] ? parsed.errors[field] : undefined)

  const addRow = () => {
    if (1 + rows.length >= MAX_RECIPIENTS) return
    setRows((rs) => [...rs, { id: nextRowId.current++, addr: '', pct: '' }])
  }
  const removeRow = (id: number) => setRows((rs) => rs.filter((r) => r.id !== id))
  const patchRow = (id: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  // ── 写链 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.k !== 'signing' || fired.current) return
    if (!parsed.ok || parsed.priceWei === null) return
    fired.current = true

    write.writeContract({
      abi: creatorSplitterAbi,
      address: SPLITTER_ADDRESS,
      functionName: 'createContent',
      // contentHash 这一版仍然传 0:W4 没有内容文件,内容存证要等 W5 上传。
      // 方案 §8.1 冻结的定义是"内容文件的 keccak256" —— 给它编一个别的语义
      // (比如哈希标题)会让 W7 的 Agent 脚本与前端产生分叉,那是 §8.1 明令避免的。
      // (决策记录:W4-实施计划.md 决策 4,选的是"维持 0x0")
      args: [
        contentId,
        parsed.priceWei,
        `0x${'0'.repeat(64)}` as Hex,
        parsed.recipients,
        parsed.splits,
      ],
    })
  }, [state, parsed, contentId, write])

  useEffect(() => {
    if (write.data && state.k === 'signing') dispatch({ type: 'sent', hash: write.data })
  }, [write.data, state.k])

  useEffect(() => {
    if (write.error && state.k === 'signing') {
      dispatch({
        type: 'fail',
        reason: classifyError(write.error, 2),
        detail: shortReason(write.error),
      })
    }
  }, [write.error, state.k])

  useEffect(() => {
    if (state.k !== 'pending') return
    if (receipt.isSuccess) {
      // 创建成功后把标题记在本机 —— 看板和分享链接都靠它。
      // 合约里没有标题字段(见 lib/contentMeta.ts)
      rememberContent(contentId, parsed.title)
      dispatch({ type: 'done', contentId, hash: state.hash })
    } else if (receipt.isError) {
      dispatch({
        type: 'fail',
        reason: classifyError(receipt.error, 2),
        detail: shortReason(receipt.error),
      })
    }
  }, [state, receipt.isSuccess, receipt.isError, receipt.error, contentId, parsed.title])

  const restart = () => {
    fired.current = false
    write.reset()
    dispatch({ type: 'reset' })
  }

  const atCap = 1 + rows.length >= MAX_RECIPIENTS
  const blockers = Object.keys(parsed.errors).length

  return (
    <>
      <PageHeader
        title="创建付费内容"
        subtitle={
          <>
            定好价格和分账比例,拿到一个付费页。买家付稳定币,
            <span className="text-neutral-300">钱按比例直达各方钱包</span> —— 无平台抽成,无资金池。
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card
          title="内容与定价"
          hint={`标题 / 价格 / 分账(最多 ${MAX_RECIPIENTS} 方)。内容文件与预览图是 W5。`}
          className="lg:col-span-3"
        >
          <div className="space-y-5">
            <div>
              <label className={LABEL} htmlFor="title">
                标题
              </label>
              <input
                id="title"
                className={INPUT}
                value={title}
                maxLength={TITLE_MAX}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => markTouched('title')}
                placeholder="例如:PPT 模板套装"
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted/70">
                ⚠️ 合约里<span className="text-neutral-300">没有标题字段</span>
                ,所以标题靠分享链接带走(<code>?t=</code>)。
                它只用于展示,不影响价格和分账。真正落地要等 W5/W8 的链下存储。
              </p>
              {shown('title') && (
                <p className="mt-1.5 text-[11px] text-accent-soft">{shown('title')}</p>
              )}
            </div>

            <div>
              <label className={LABEL} htmlFor="price">
                价格(USDC)
              </label>
              <input
                id="price"
                className={INPUT}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                onBlur={() => markTouched('price')}
                inputMode="decimal"
                placeholder="0.2"
              />
              {parsed.priceWei !== null && parsed.priceWei > 0n && (
                <p className="mt-1.5 text-[11px] text-muted/70 tnum">
                  链上记作 {parsed.priceWei.toString()}(USDC 是 6 位小数)
                </p>
              )}
              {shown('price') && (
                <p className="mt-1.5 text-[11px] text-accent-soft">{shown('price')}</p>
              )}
            </div>

            {/* ── 分账编辑器 ──────────────────────────────────── */}
            <div className="rounded-xl border border-line-soft bg-surface-2/30 p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <span className="text-xs text-muted">收款方</span>
                <span className="text-xs text-muted">比例</span>
              </div>

              <div className="space-y-2.5">
                {/* 第 1 行:我。地址只读 —— 合约的 creator 恒为 msg.sender,
                    但钱是按 recipients 分的,第 1 行写错就是钱打到别人那 */}
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate rounded-xl border border-line/60 bg-surface-2/30 px-3.5 py-2.5 font-mono text-sm text-muted">
                      {address ?? '未连接钱包'}
                    </div>
                  </div>
                  <div className="relative w-[5.5rem] shrink-0">
                    <input
                      id="mypct"
                      aria-label="我的分账比例"
                      className={PCT_INPUT}
                      value={myPct}
                      onChange={(e) => setMyPct(e.target.value)}
                      onBlur={() => markTouched('myPct')}
                      inputMode="decimal"
                      placeholder="70"
                    />
                    <PctSuffix />
                  </div>
                  {/* 占位,让比例框与下面几行的删除按钮对齐 */}
                  <div className="w-7 shrink-0" aria-hidden />
                </div>
                {shown('myPct') && (
                  <p className="text-[11px] text-accent-soft">{shown('myPct')}</p>
                )}

                {rows.map((r) => (
                  <div key={r.id}>
                    <div className="flex items-start gap-2.5">
                      <div className="min-w-0 flex-1">
                        <input
                          aria-label="协作者地址"
                          className={`${INPUT} font-mono`}
                          value={r.addr}
                          onChange={(e) => patchRow(r.id, { addr: e.target.value })}
                          onBlur={() => markTouched(`row:${r.id}:addr`)}
                          placeholder="0x…"
                          spellCheck={false}
                        />
                      </div>
                      <div className="relative w-[5.5rem] shrink-0">
                        <input
                          aria-label="协作者分账比例"
                          className={PCT_INPUT}
                          value={r.pct}
                          onChange={(e) => patchRow(r.id, { pct: e.target.value })}
                          onBlur={() => markTouched(`row:${r.id}:pct`)}
                          inputMode="decimal"
                          placeholder="20"
                        />
                        <PctSuffix />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRow(r.id)}
                        disabled={rows.length <= 1}
                        aria-label="删除这位协作者"
                        title={rows.length <= 1 ? '至少要有一位协作者 —— 不然就不叫分账了' : '删除'}
                        className="mt-0.5 w-7 shrink-0 rounded-lg py-2 text-muted transition-colors hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        ✕
                      </button>
                    </div>
                    {shown(`row:${r.id}:addr`) && (
                      <p className="mt-1.5 text-[11px] text-accent-soft">
                        {shown(`row:${r.id}:addr`)}
                      </p>
                    )}
                    {shown(`row:${r.id}:pct`) && (
                      <p className="mt-1.5 text-[11px] text-accent-soft">
                        {shown(`row:${r.id}:pct`)}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addRow}
                disabled={atCap}
                className="mt-3 w-full rounded-xl border border-dashed border-line px-4 py-2.5 text-xs text-neutral-300 transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {atCap ? `最多 ${MAX_RECIPIENTS} 方` : '＋ 添加协作者'}
              </button>

              {/* ── 合计 ─────────────────────────────────────── */}
              <div className="mt-4 border-t border-line-soft pt-3.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted">合计</span>
                  <span
                    className={`tnum text-sm ${parsed.total === 10000 ? 'text-emerald-400' : 'text-accent-soft'}`}
                  >
                    {formatBps(parsed.total)}
                    {parsed.total === 10000 ? ' ✓' : ''}
                  </span>
                </div>
                {parsed.total !== 10000 && (
                  <p className="mt-1.5 text-[11px] text-accent-soft">{parsed.errors.sum}</p>
                )}
              </div>

              <p className="mt-3 text-[11px] leading-relaxed text-muted/70">
                前几方按比例取整,
                <span className="text-neutral-300">最后一方拿余数</span>
                —— 这样支付金额恒等于分账之和,合约不留灰尘。
                改行序或删行会让余数换人,各方金额最多差 0.000001 USDC。
              </p>

              {parsed.warnings.length > 0 && (
                <ul className="mt-2.5 space-y-1">
                  {parsed.warnings.map((w) => (
                    <li key={w} className="text-[11px] leading-relaxed text-amber-300/80">
                      ⚠️ {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        {/* ── 预览 + 提交 ──────────────────────────────────── */}
        <Card title="这会生成什么" hint="下面就是买家在付费页上看到的分账明细" className="lg:col-span-2">
          <div className="flex flex-1 flex-col gap-5">
            <div className="rounded-xl border border-line-soft bg-surface-2/40 p-4">
              <p className="text-sm text-neutral-200">{normalizeTitle(title) || '付费内容'}</p>
              <p className="mt-1.5 font-mono tnum text-2xl font-semibold">
                {parsed.priceWei !== null ? formatUsdc(parsed.priceWei) : '—'}
                <span className="ml-1.5 text-xs font-normal text-muted">USDC</span>
              </p>

              {/*
                这里**不要**加 `&& address` —— 几行写的是"我"和各协作者,
                只是比例分配,根本不需要知道钱包地址。之前挂了 address,
                结果没连钱包时这张卡片是半空的:填了 70% 却看不到 30% 归谁。
              */}
              <ul className="mt-3.5 space-y-1.5 border-t border-line-soft pt-3.5 text-xs">
                <li className="flex justify-between">
                  <span className="text-neutral-300">我</span>
                  <span className="tnum text-muted">
                    {parsed.myBps !== null ? formatBps(parsed.myBps) : '—'}
                  </span>
                </li>
                {rows.map((r, i) => (
                  <li key={r.id} className="flex justify-between">
                    <span className="text-neutral-300">协作者 {i + 1}</span>
                    <span className="tnum text-muted">
                      {parsed.rowBps[i] !== null ? formatBps(parsed.rowBps[i]!) : '—'}
                    </span>
                  </li>
                ))}
              </ul>

              {/* 只有合计正确时才显示"实际到手多少" —— 合计不对时链上会 revert,
                  这时按余数规则算出来的金额是**假的**,显示了反而误导。
                  (与标题、地址无关,别把它挂到 `parsed.ok` 上,见 `amountPreview` 的注释) */}
              {parsed.amountPreview && (
                <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-3 text-xs">
                  {parsed.amountPreview.map((amt, i) => (
                    <li key={i} className="flex justify-between">
                      <span className="text-muted/70">{i === 0 ? '我' : `协作者 ${i}`}</span>
                      <span className="tnum text-neutral-300">{formatUsdc(amt)} USDC</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── 状态 ─────────────────────────────────────── */}
            {state.k === 'signing' && (
              <p className="text-xs leading-relaxed text-muted">请在钱包里确认这笔创建交易…</p>
            )}
            {state.k === 'pending' && (
              <p className="text-xs leading-relaxed text-muted">
                已提交,等待上链 ——{' '}
                <a
                  href={explorerTx(state.hash)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline decoration-line underline-offset-2 hover:decoration-accent"
                >
                  {shortHash(state.hash)}
                </a>
              </p>
            )}
            {state.k === 'failed' && (
              <div className="rounded-xl border border-accent/35 bg-accent/[0.07] px-4 py-3">
                <p className="text-sm text-neutral-100">{describeFailure(state.reason).title}</p>
                {describeFailure(state.reason).hint && (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    {describeFailure(state.reason).hint}
                  </p>
                )}
              </div>
            )}

            <div className="mt-auto">
              {!isConnected ? (
                <ConnectButton variant="block" />
              ) : !onFuji ? (
                <ConnectButton variant="block" />
              ) : state.k === 'done' ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3">
                    <p className="text-sm text-neutral-100">✓ 已创建并上链</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      分享下面这个链接或二维码,买家扫码就能付款。
                    </p>
                  </div>
                  <ShareRow contentId={state.contentId} title={parsed.title} />
                  <button
                    type="button"
                    onClick={restart}
                    className="w-full rounded-xl border border-line bg-surface-2 px-5 py-3 text-sm text-neutral-200 transition-colors hover:border-accent"
                  >
                    再创建一个
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'sign' })}
                  disabled={!canSubmit}
                  className="w-full rounded-xl bg-accent px-5 py-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {state.k === 'signing'
                    ? '等待钱包确认…'
                    : state.k === 'pending'
                      ? '上链中…'
                      : state.k === 'failed'
                        ? '重新检查并再试'
                        : '创建并上链'}
                </button>
              )}

              {/* 提交按钮点不动时,必须说清楚是哪里没填好 —— 灰着不给理由是最气人的 */}
              {isConnected && onFuji && !parsed.ok && state.k !== 'done' && (
                <p className="mt-2.5 text-[11px] leading-relaxed text-muted">
                  上面还有 {blockers} 处没填好。
                </p>
              )}
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}

/** 创建成功后的分享区:链接 + 二维码 + 复制按钮 */
function ShareRow({ contentId, title }: { contentId: Hex; title: string }) {
  const url = buildShareUrl(contentId, title)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板 API 在非 HTTPS / 无权限时会 reject。
      // 不弹错误 —— 链接就在下面,用户能手选复制
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface-2/50 p-3">
        <p className="break-all font-mono text-[11px] leading-relaxed text-muted">{url}</p>
      </div>
      <div className="flex justify-center">
        <ShareQr url={url} caption="买家扫码即可打开付费页" />
      </div>
      <button
        type="button"
        onClick={copy}
        className="w-full rounded-xl border border-line bg-surface-2 px-5 py-2.5 text-xs text-neutral-200 transition-colors hover:border-accent"
      >
        {copied ? '已复制' : '复制链接'}
      </button>
    </div>
  )
}
