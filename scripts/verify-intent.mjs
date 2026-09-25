#!/usr/bin/env node
/**
 * verify-intent.mjs —— W14 包 A 的**纯逻辑**验机:模型输出那道闸 + 筛选规则
 *
 * ## 为什么非要有它(而不是"跑过 typecheck 了")
 *
 * 这一包里有两处**只靠类型检查兜不住**的东西:
 *
 * **① `sanitizeIntent` —— "模型吐什么我们就信什么"的唯一一道闸。**
 * 类型签名是 `unknown → SearchIntent`,任何形状的 JSON 都能满足它。
 * 而它要挡的是一组很具体的坏值:`"0.5e6"`(科学计数法)、`"0.1234567"`
 * (USDC 只有 6 位小数)、`0`(当成"上限 0 元"会把结果筛空,而那看起来
 * **和"目录里没有东西"一模一样**)。这些都不是类型能表达的。
 *
 * **② 金额比较必须走 BigInt 且区间是闭的。**
 * `"100000" < "20000"` 是 `true`(字典序),`0.2 * 1e6` 是
 * `200000.00000000003` —— 见 `shared/units.ts` 文件头那一族 bug。
 * 边界差一个单位,前端预览的数字就和链上对不上账。
 *
 * ## ⚠️ 为什么要有"编译"这一步
 *
 * 这些代码是 TypeScript,而 Node 直接跑 `.ts` 要处理 `./x.js` → `x.ts`
 * 的路径改写。所以先把**四个纯文件**编到 `.intent-check/`,再断言。
 * 编的是**仓库里那份真代码** —— 在断言文件里重抄一遍逻辑只能证明我抄对了,
 * 证明不了仓库里那份对。
 *
 * ⚠️ 只编 `intent / filterContents / units / chain` 这四个:
 * 它们不读 `process.env`、不发网络请求。别顺手把 `server/` 下的拉进来,
 * 那会让"纯逻辑验机"变成一件需要跑起服务端的事。
 *
 * ## 它**不验**什么
 *
 * `api/parse-intent.ts` 里真的去 fetch Anthropic 那一跳(鉴权头、body 形状、
 * 从 content 数组里取 tool_use 块)**不在本脚本范围内** —— 那需要一个真 key,
 * 属于"接上 key 之后必须补的一次冒烟"。前端那一侧由
 * `shot/probe-intent-search.mjs` 用同形状的 stub 验。
 *
 * 用法:`node scripts/verify-intent.mjs`
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(ROOT, 'package.json'))
const TSC = join(dirname(require.resolve('typescript/package.json')), 'lib', 'tsc.js')
const OUT = join(ROOT, '.intent-check')

let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`  ✓ ${name} → ${g}`)
  } else {
    fails.push(name)
    console.log(`  ✗ ${name}\n      得到 ${g}\n      期望 ${w}`)
  }
}
const section = (t) => console.log(`\n── ${t}`)

/* ──────────────────── 先把真代码编出来 ──────────────────── */

rmSync(OUT, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [
    TSC,
    // ⚠️ 仓库里有 tsconfig.json,不忽略它 tsc 会拒绝这套命令行参数(TS5112)
    '--ignoreConfig',
    'shared/intent.ts',
    'shared/filterContents.ts',
    'shared/units.ts',
    'shared/chain.ts',
    '--outDir',
    OUT,
    '--module',
    'esnext',
    '--moduleResolution',
    'bundler',
    '--target',
    'es2022',
    '--skipLibCheck',
  ],
  { stdio: 'inherit' },
)

// ⚠️ 必须是**动态** import:上面那一步才刚把文件编出来
const { sanitizeIntent } = await import(pathToFileURL(join(OUT, 'intent.js')).href)
const { filterContents, parsePriceBound, normalizeKeyword, describeFilter, isEmptyFilter } = await import(
  pathToFileURL(join(OUT, 'filterContents.js')).href
)

/* ─────────────────── ① 模型输出那道闸 ─────────────────── */

section('sanitizeIntent · 价格(坏值必须丢,而不是改写成 0)')
eq('"0.50" 规范化成 "0.5"(回显与筛选用同一个字符串)', sanitizeIntent({ minPrice: '0.50' }).minPrice, '0.5')
eq('数字字面量 0.5 也接住', sanitizeIntent({ minPrice: 0.5 }).minPrice, '0.5')
eq('整数 "1" 原样', sanitizeIntent({ maxPrice: '1' }).maxPrice, '1')
eq('科学计数法 "0.5e6" 丢掉', sanitizeIntent({ minPrice: '0.5e6' }).minPrice, null)
eq('超精度 "0.1234567" 丢掉(USDC 只有 6 位)', sanitizeIntent({ minPrice: '0.1234567' }).minPrice, null)
eq('负数 -1 丢掉', sanitizeIntent({ minPrice: -1 }).minPrice, null)
eq('垃圾 "abc" 丢掉', sanitizeIntent({ minPrice: 'abc' }).minPrice, null)
eq('空串 丢掉', sanitizeIntent({ minPrice: '' }).minPrice, null)
eq('缺失 就是 null', sanitizeIntent({}).minPrice, null)
eq('⚠️ 单项坏掉不掀桌子:关键词保住', sanitizeIntent({ keyword: '苹果', minPrice: 'abc' }), {
  keyword: '苹果',
  minPrice: null,
  maxPrice: null,
  limit: null,
})

section('sanitizeIntent · 数量上限(0 与负数是"不限",不是"要 0 件")')
eq('limit 0 ⇒ null(⚠️ 当成 0 会显示"找到 0 件",像产品坏了)', sanitizeIntent({ limit: 0 }).limit, null)
eq('limit -3 ⇒ null', sanitizeIntent({ limit: -3 }).limit, null)
eq('limit 2.9 向下取整 ⇒ 2', sanitizeIntent({ limit: 2.9 }).limit, 2)
eq('limit 1000 封顶 ⇒ 100', sanitizeIntent({ limit: 1000 }).limit, 100)
eq('limit "3"(字符串)⇒ null(只认数字)', sanitizeIntent({ limit: '3' }).limit, null)

section('sanitizeIntent · 关键词与整体形状')
eq('关键词去首尾空白', sanitizeIntent({ keyword: '  苹果  ' }).keyword, '苹果')
eq('关键词全空白 ⇒ null(等于不筛)', sanitizeIntent({ keyword: '   ' }).keyword, null)
eq('关键词截到 40 字', sanitizeIntent({ keyword: 'x'.repeat(80) }).keyword.length, 40)
eq('关键词不是字符串 ⇒ null', sanitizeIntent({ keyword: 123 }).keyword, null)
eq('整个 input 是 null ⇒ 四项全 null', sanitizeIntent(null), { keyword: null, minPrice: null, maxPrice: null, limit: null })
eq('整个 input 是字符串 ⇒ 四项全 null', sanitizeIntent('胡说八道'), {
  keyword: null,
  minPrice: null,
  maxPrice: null,
  limit: null,
})

/* ─────────────────── ② 金额与筛选规则 ─────────────────── */

section('parsePriceBound(人说的话 → 链上整数)')
eq('空串 ⇒ null(这一端不设限,而不是 0)', parsePriceBound(''), null)
eq('"0.5" ⇒ 500000n', parsePriceBound('0.5').toString(), '500000')
eq('"0.2" ⇒ 200000n(浮点会算出 200000.00000000003)', parsePriceBound('0.2').toString(), '200000')
eq('normalizeKeyword("  ") ⇒ null', normalizeKeyword('  '), null)
try {
  parsePriceBound('abc')
  eq('非法价格必须抛 AmountError', '没抛', '抛了')
} catch (e) {
  eq('非法价格抛 AmountError(不静默当成 0)', e.name, 'AmountError')
}

section('filterContents(金额一律 BigInt,区间是闭的)')
const cat = [
  { contentId: 'a', title: '苹果图', price: '200000', decimals: 6, creator: '0x1', currency: 'USDC', chainId: 43113, previewUrl: null },
  { contentId: 'b', title: 'newTest', price: '100000', decimals: 6, creator: '0x2', currency: 'USDC', chainId: 43113, previewUrl: null },
  { contentId: 'c', title: null, price: '150000', decimals: 6, creator: '0x3', currency: 'USDC', chainId: 43113, previewUrl: null },
]
const f = (o) => ({ keyword: null, minRaw: null, maxRaw: null, limit: null, ...o })
const ids = (r) => r.map((x) => x.contentId).join('')
eq('上限 0.149999 ⇒ 只剩 0.1 那件', ids(filterContents(cat, f({ maxRaw: 149999n }))), 'b')
eq('下限 0.15 ⇒ 剩 0.2 那件(0.15 那件被排除)', ids(filterContents(cat, f({ minRaw: 150001n }))), 'a')
eq('边界是闭区间:≤150000 含 0.15 那件', ids(filterContents(cat, f({ maxRaw: 150000n }))), 'bc')
eq('关键词只匹配标题 ⇒ 无标题的永远匹配不上', ids(filterContents(cat, f({ keyword: '图' }))), 'a')
eq('关键词不区分大小写', ids(filterContents(cat, f({ keyword: 'newtest' }))), 'b')
eq('limit 取前 N 件(依赖目录本身最新在前)', ids(filterContents(cat, f({ limit: 2 }))), 'ab')
eq('空条件 ⇒ 全部(与"筛完为空"是两件事)', ids(filterContents(cat, f({}))), 'abc')
eq('筛不到 ⇒ 空数组', ids(filterContents(cat, f({ keyword: '不存在的东西' }))), '')

section('describeFilter / isEmptyFilter(界面回显的那句话)')
eq('空条件', describeFilter(f({})), '全部在售内容')
eq('只有上限', describeFilter(f({ maxRaw: 500000n })), '≤ 0.5 USDC')
eq('区间', describeFilter(f({ minRaw: 100000n, maxRaw: 500000n })), '0.1 – 0.5 USDC')
eq('组合', describeFilter(f({ keyword: '图', maxRaw: 500000n, limit: 3 })), '关键词「图」 · ≤ 0.5 USDC · 最多 3 件')
eq('isEmptyFilter 认空条件', isEmptyFilter(f({})), true)
// ⚠️ 这条防的是"真值判断":写成 `filter.maxRaw ? … : …` 的话 0n 会被当成"没筛",
// 于是用户填的「最高价 0」被静默当成不限 —— 一次无声的失败
eq('⚠️ 上限 0 算有 条件(必须是 `!== null`,不是真值判断)', isEmptyFilter(f({ maxRaw: 0n })), false)

/* ─────────────────────────── 收尾 ─────────────────────────── */

rmSync(OUT, { recursive: true, force: true })

const total = pass + fails.length
console.log(`\n${'═'.repeat(56)}\n${pass}/${total} 通过`)
if (fails.length) {
  console.log('失败:')
  for (const x of fails) console.log(`  · ${x}`)
  process.exit(1)
}
