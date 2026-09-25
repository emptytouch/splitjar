import { USDC } from './chain.js'

/**
 * 人类可读值 ↔ 链上整数。
 *
 * ## ⚠️ 2026-09-26 从 `src/lib/units.ts` 搬到这里
 *
 * 原因是 W14 包 A 的筛选逻辑(`shared/filterContents.ts`)要用 `parseUsdc`
 * 把「0.5 以下」这种**人说的话**换算成能和 `CatalogEntry.price` 比较的整数 ——
 * 而 `shared/` **不许 import `src/`**。这正是 `shared/chain.ts` 那条规矩:
 * 两端都要用的东西放 `shared/`,让它成为结构上的事实。
 *
 * 搬完 `lib/units.ts` 就没有了 —— 原路径**不保留转发文件**:留一个
 * `export * from '../../shared/units'` 会让"这文件到底在哪"永远有两个答案。
 *
 * ⚠️ **全程走字符串,一次浮点都不碰。**
 *
 * 这不是洁癖,是 `lib/format.ts` 里记的那类 bug 的同一族:
 * `0.2 * 1e6` 在 IEEE 754 下是 `200000.00000000003`,而 `1.1 * 1e6` 是
 * `1100000.0000000002` —— `BigInt()` 直接抛,`Math.round()` 则是把错误藏起来。
 * 金额换算上"藏起来的错误"就是钱错。
 *
 * 所以:小数点两边各当字符串处理,补零 / 切片,**整数运算只发生在 BigInt 上**。
 *
 * 单位约定见方案 §8.1:`0.1 USDC` → `100000`;分账用**基点**,`[7000, 2000, 1000]`
 * → 70/20/10,合计必须 == 10000。
 */

/** 解析失败时抛这个,调用方据此把输入框标红(而不是静默取 0) */
export class AmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountError'
  }
}

/**
 * `"0.2"` → `200000n`。
 *
 * 接受 `"1"` / `"0.2"` / `".5"` / `"1."`;拒绝空串、纯小数点、负号、
 * 科学计数法,以及**超出精度的小数位**。
 *
 * 最后一条是刻意的:USDC 只有 6 位小数,用户填 `"0.0000001"` 时
 * **必须报错而不是截断** —— 截断会让链上付的钱和界面上写的钱对不上。
 */
export function parseUsdc(input: string, decimals: number = USDC.decimals): bigint {
  const s = input.trim()
  if (s === '') throw new AmountError('金额不能为空')
  if (!/^\d*\.?\d*$/.test(s) || s === '.') throw new AmountError('金额只能是数字和小数点')

  const dot = s.indexOf('.')
  const intPart = (dot === -1 ? s : s.slice(0, dot)) || '0'
  const fracPart = dot === -1 ? '' : s.slice(dot + 1)

  if (fracPart.length > decimals) {
    throw new AmountError(`最多 ${decimals} 位小数(USDC 精度)`)
  }

  // 补齐到固定位数后拼成一个纯整数字符串 —— 到这里浮点已经不可能介入了
  return BigInt(intPart + fracPart.padEnd(decimals, '0'))
}

/**
 * `200000n` → `"0.2"`。末尾的零去掉,整数金额不带小数点。
 *
 * 不做千分位分隔 —— 那是展示层的事,而且 `toLocaleString` 正是
 * `format.ts` 里踩过的坑。
 */
export function formatUsdc(raw: bigint, decimals: number = USDC.decimals): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw

  // 至少 decimals+1 位,保证 slice 的两段都拿得到内容
  const s = abs.toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, s.length - decimals)
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, '')

  return `${negative ? '-' : ''}${intPart}${fracPart ? `.${fracPart}` : ''}`
}

/** 带单位的显示:`200000n` → `"0.2 USDC"` */
export function formatUsdcWithSymbol(raw: bigint, decimals: number = USDC.decimals): string {
  return `${formatUsdc(raw, decimals)} ${USDC.symbol}`
}

/**
 * `"70"` → `7000`(基点)。分账比例专用。
 *
 * 与 `parseUsdc` 同样的理由走字符串,并且**允许两位小数**
 * (`"33.33"` → `3333`)—— 三方分账填 33.33/33.33/33.34 是真实需求。
 */
export function parseBps(input: string): number {
  const s = input.trim()
  if (s === '') throw new AmountError('比例不能为空')
  if (!/^\d*\.?\d*$/.test(s) || s === '.') throw new AmountError('比例只能是数字和小数点')

  const dot = s.indexOf('.')
  const intPart = (dot === -1 ? s : s.slice(0, dot)) || '0'
  const fracPart = dot === -1 ? '' : s.slice(dot + 1)

  if (fracPart.length > 2) throw new AmountError('比例最多两位小数')

  const bps = Number(intPart + fracPart.padEnd(2, '0'))
  if (bps > 10000) throw new AmountError('单项比例不能超过 100%')
  return bps
}

/** `7000` → `"70%"`;`7050` → `"70.5%"` */
export function formatBps(bp: number): string {
  if (bp === 10000) return '100%'
  const s = String(bp).padStart(3, '0')
  const intPart = s.slice(0, s.length - 2)
  const fracPart = s.slice(s.length - 2).replace(/0+$/, '')
  return `${intPart}${fracPart ? `.${fracPart}` : ''}%`
}

/**
 * 按分账比例算每一方实际能拿到多少 —— **必须与合约算法逐字一致**。
 *
 * 合约(`CreatorSplitter.pay()` 里那段循环)的算法是:前 N-1 方取
 * `floor(amount × split / 10000)`,最后一方取 `amount − 前面之和`。
 * ⚠️ 合约里**没有** `_split` 这个函数,分账是内联在 `pay()` 里的 ——
 * 之前这里写成 `CreatorSplitter._split`,会让人去找一个不存在的东西。
 *
 * 前端**必须复刻这个余数规则**,否则创建页/付费页预览的数字会比链上少 1 个单位,
 * 用户对不上账。方案 §8.1 把这条列为"容易漏"。
 */
export function previewShares(amount: bigint, splits: readonly number[]): bigint[] {
  const out: bigint[] = []
  let assigned = 0n

  for (let i = 0; i < splits.length - 1; i++) {
    const share = (amount * BigInt(splits[i])) / 10000n // BigInt 除法本身就是 floor
    out.push(share)
    assigned += share
  }

  out.push(amount - assigned) // 最后一方吃掉余数
  return out
}
