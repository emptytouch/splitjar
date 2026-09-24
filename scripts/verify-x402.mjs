#!/usr/bin/env node
/**
 * `/api/content/:id` 的**反例矩阵** —— `W7-实施计划.md` §5.4 那张表,可重跑版。
 *
 * ## 为什么要有它
 *
 * W7 的 DoD 第二条是「**五条校验逐条有可复现的反例测试**」。
 * 2026-09-23 那次是靠**手工 curl**验的 —— 验过了,但**下次改判定顺序不会自动报警**。
 * 而判定顺序恰恰是这块最脆的地方(见 `api/content/[id].ts` 文件头:
 * 顺序写错会造出一个"付过钱的人被挡在门外"的真 bug)。
 * 所以把那次的手工矩阵落成这个脚本。
 *
 * ## ⚠️ 它**不持有私钥,也不花钱**
 *
 * 只读一个**公开地址**(`X402_PAYER`)和公开 RPC。需要"一笔真实付款"当合法凭证时,
 * 它自己从链上把交易找出来 —— 见下面 `findLivePayment` 的"无损探针"。
 * 唯一会**消耗凭证**的两条(200 happy path 与 409 重放)藏在 `--burn` 后面,
 * 默认不跑,所以**默认用法可以无限次重跑**。
 *
 * 这是刻意的:私钥纪律见 `.env.example` —— 私钥只在当前 shell export,
 * 绝不进仓库、绝不进前端产物。一个验证脚本没有理由碰它。
 *
 * ## 用法
 *
 * ```bash
 * # 只跑不需要付款的那些(默认,可无限重跑)
 * node scripts/verify-x402.mjs
 *
 * # 带上付款人地址 —— 会扫链找一笔还没被兑过的付款,多跑 3 条
 * X402_PAYER=0x9750… node scripts/verify-x402.mjs
 *
 * # 加上会消耗凭证的两条(跑完那笔付款就永久不能再用)
 * X402_PAYER=0x9750… node scripts/verify-x402.mjs --burn
 *
 * # 打生产
 * BASE_URL=https://splitjar.vercel.app X402_PAYER=0x9750… node scripts/verify-x402.mjs
 * ```
 *
 * 环境变量:
 *   BASE_URL            默认 http://127.0.0.1:3000
 *   X402_PAYER          付款人地址(**不是**私钥)。给了才会跑 B/C 组
 *   X402_RPC            默认走公共 Fuji(与 shared/chain.ts 的 DEFAULT_RPC_PRIMARY 同值)
 *   X402_INACTIVE_ID    一件**已下架**内容的 contentId,用来验 403 content_inactive。
 *                       下架的内容不在 catalog 里,所以这个没法自动推出来,得给。
 *   QUOTE_HMAC_SECRET   只在**本机**有(vercel dev 的 Development 环境)。
 *                       给了才能自签一份过期报价去验 410 quote_expired。
 *
 * 参数:
 *   --burn        允许跑消耗凭证的两条(200 / 409)
 *   --verbose     打印每个请求的 URL
 *   --help
 *
 * ## ⚠️ 与本机网络的两件事(踩过,别当成脚本的 bug)
 *
 * 1. **打本机 dev server 要用 `127.0.0.1`,不能用 `localhost`** —— `localhost`
 *    在这台机器上走 IPv6,`curl`/`fetch` 直接连不上(端口在 `0.0.0.0:3000` 上听着)。
 *    所以默认值就是 `127.0.0.1`。
 * 2. **本机够不到 `*.vercel.app`**(DNS 被劫持)。打生产只能从浏览器 console 跑,
 *    或者把本脚本当作"该在 CI / 另一台机器上跑"的东西。**本机跑生产必然全红。**
 *    链上 RPC 反而是通的 —— 所以"扫链找付款"这一步本机能做。
 */

import { createHmac, randomBytes } from 'node:crypto'
import { createPublicClient, getAddress, http, parseAbiItem } from 'viem'

/* ─────────────────────────── 常量(与源码对齐) ─────────────────────────── */

/**
 * ⚠️ 这几个数字是**从源码抄过来的**,不是这里另立的。
 * 抄写本身有漂移风险,所以每一条都注了出处 —— 改了那边,这里会先红。
 */
const SPLITTER = '0xDe9b3090263e20ebD5b3795F0199B500f6da72f5' // shared/chain.ts DEPLOYED_SPLITTER
const DEPLOY_BLOCK = 58_513_443n // shared/chain.ts DEPLOY_BLOCK
const DEFAULT_RPC = 'https://api.avax-test.network/ext/bc/C/rpc' // shared/chain.ts DEFAULT_RPC_PRIMARY
const PAYMENT_HEADER = 'X-Payment' // shared/agentPay.ts PAYMENT_HEADER
const AGENT_URL_TTL_SECONDS = 60 // shared/unlock.ts UNLOCK_URL_TTL_SECONDS

/**
 * `PaymentSplit` 事件。用 `parseAbiItem` 现写一遍而不是 import 仓库那份 ABI ——
 * 那份是 `.ts`,`node` 直接跑不了。形状与 `shared/abi/creatorSplitter.ts:288` 一致。
 */
const PAYMENT_SPLIT = parseAbiItem(
  'event PaymentSplit(bytes32 indexed contentId, address indexed payer, address[] recipients, uint256[] amounts)',
)

/** 探针用的假付款人 —— 刻意用一个不可能真付款的地址。见 `findLivePayment` */
const PROBE_PAYER = '0x000000000000000000000000000000000000dEaD'

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const RPC = process.env.X402_RPC ?? DEFAULT_RPC
const PAYER = process.env.X402_PAYER ? getAddress(process.env.X402_PAYER) : null
const INACTIVE_ID = process.env.X402_INACTIVE_ID ?? null
const QUOTE_SECRET = process.env.QUOTE_HMAC_SECRET || null

const BURN = process.argv.includes('--burn')
const VERBOSE = process.argv.includes('--verbose')

if (process.argv.includes('--help')) {
  console.log(await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url), 'utf8')).then((s) => s.split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').trim()))
  process.exit(0)
}

const publicClient = createPublicClient({ transport: http(RPC) })

/* ─────────────────────────────── 断言收集 ─────────────────────────────── */

const results = []

/**
 * 记一条结果。
 *
 * ⚠️ `skip` 与 `fail` 是**两种东西**,不能混:
 * 跳过说明"这次没条件验"(缺付款人 / 缺密钥),而失败说明"验了,结果不对"。
 * 把跳过算成通过,就等于给了一份**看起来全绿**的报告 —— 那比没有报告更坏。
 */
function record(name, outcome, detail = '') {
  results.push({ name, outcome, detail })
  const mark = outcome === 'pass' ? '✅' : outcome === 'fail' ? '❌' : outcome === 'skip' ? '⏭ ' : '⚠️ '
  console.log(`${mark} ${name}${detail ? `\n     ${detail}` : ''}`)
}

/**
 * 期望一次「状态码 + 错误码」。
 *
 * ⚠️ **两个都要断。** 只断状态码会漏掉一整类 bug:`payment_mismatch` 与
 * `quote_invalid` 都是 403 —— 顺序写错时状态码对得上、错误码对不上。
 * 这正是 §三 那个"顺序写错会造出真 bug"要防的东西。
 */
function expect(name, got, wantStatus, wantCode, note = '') {
  // `null` = **没条件验**(调用方已经知道原因,写在了 note 里)。
  // ⚠️ 是 skip 不是 fail:把它算成失败,会让"内容只有一件"这种环境问题
  // 看起来像代码 bug。反过来把它算成通过更坏 —— 那是伪造一份全绿。
  if (got === null) {
    record(name, 'skip', note)
    return
  }

  const okStatus = got.status === wantStatus
  const okCode = wantCode === null || got.body?.error?.code === wantCode
  if (okStatus && okCode) {
    record(name, 'pass', note)
  } else {
    record(
      name,
      'fail',
      `期望 ${wantStatus}${wantCode ? ` ${wantCode}` : ''},实得 ${got.status} ${got.body?.error?.code ?? JSON.stringify(got.body).slice(0, 120)}\n     ${note}`,
    )
  }
}

/* ────────────────────────────── HTTP 小工具 ────────────────────────────── */

async function call(path, { header } = {}) {
  const url = `${BASE_URL}${path}`
  if (VERBOSE) console.log(`  → ${header ? `${PAYMENT_HEADER} … ` : ''}${url}`)
  let res
  try {
    res = await fetch(url, { headers: header ? { [PAYMENT_HEADER]: header } : {} })
  } catch (e) {
    // 连不上(本机打 *.vercel.app 就是这个症状)。当场说清楚,别让它表现成"二十条断言全红"
    throw new Error(
      `连不上 ${url} —— ${e.message}\n` +
        `如果是 *.vercel.app:本机 DNS 把那个域劫持了,只能从浏览器 console 打。\n` +
        `如果是本机 dev server:用 127.0.0.1,别用 localhost(IPv6 解析会失败)。`,
    )
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 200)
  }
  return { status: res.status, body }
}

/** 拼一条 `X-Payment` 头。⚠️ 五个字段**全是字符串**,`parseXPayment` 会逐个查 */
function paymentHeader({ txHash, payer, quoteId, expiresAt, sig }) {
  return JSON.stringify({
    txHash,
    payer,
    quoteId,
    expiresAt: String(expiresAt),
    sig,
  })
}

/** 取一份真报价(无头请求 → 402) */
async function getQuote(contentId) {
  const got = await call(`/api/content/${contentId}`)
  if (got.status !== 402) return { error: got }
  return { quote: got.body.quote, body: got.body }
}

/**
 * 自签一份**过期**报价 —— 第 ⑦ 条(410 `quote_expired`)的唯一办法。
 *
 * ## ⚠️ 为什么这是**独立实现**,而不是 import `server/quote.ts`
 *
 * 因为那样就只能验"服务端的签名能通过服务端自己的验签" —— 一个自洽的循环。
 * 这里按 `server/quote.ts` 文件头写死的那个载荷格式**重新算一遍**:
 * `[contentId, quoteId, String(expiresAt)].join('|')`,HMAC-SHA256,hex 加 `0x`。
 * 服务端要是哪天偷偷改了载荷(比如又往签名里加字段 —— 那正是该文件头记着的那个坑),
 * **这里会红**,而不是两边一起悄悄改掉。
 *
 * 漂移风险是真的,但它**响亮地失败**,不会静默。
 *
 * ## ⚠️ 2026-09-24:这个实现的**本机还没验过**
 *
 * 想验它,必须先让请求走到第 ⑤ 条;而第 ⑤ 条排在 `reservePayment` **之后**,
 * 也就是**要先过 KV**。本机够不到 `*.upstash.io`(见 §6.3.3),那条路走不到 ——
 * 所以这个 HMAC 是否与 `server/quote.ts` 逐字节一致,**目前只是照抄了源码**。
 *
 * **它错了会怎样**:不是静默 —— 服务端回 `403 quote_invalid`,脚本报
 * 「期望 410,实得 403」,一眼能看出是签名对不上,而不是第 ⑤ 条坏了。
 * 真跑到那一步的红,是**这条的实现错了**,不是被测的东西错了。
 */
function signExpiredQuote(contentId, expiresAt) {
  const quoteId = `0x${randomBytes(32).toString('hex')}`
  const payload = [contentId, quoteId, String(expiresAt)].join('|')
  const sig = `0x${createHmac('sha256', QUOTE_SECRET).update(payload).digest('hex')}`
  return { contentId, quoteId, expiresAt, sig }
}

/**
 * 切窗口 —— 本地复制 `shared/blockWindows.ts` 的 `blockWindows`,不 import。
 *
 * ## ⚠️ 为什么本地复制,而不是 import
 *
 * 与 `signExpiredQuote` 同一条纪律(见上面):那份是 `.ts`,`node` 不能直接跑,
 * 而脚本又刻意不依赖仓库内部模块 — — 这里是验证**服务端的独立实现**,
 * 复制的意义正是"算法同源、代码独立",服务端哪天改了切法,这里会红。
 *
 * ## 口径(与 shared/blockWindows.ts 同源,细节看那边)
 *
 * 公共 RPC 对单次 `getLogs` 的范围有上限:备端点实测 `to - from` 到 49,999 都行,
 * 50,000 就报 `-32701 exceed maximum block range: 50000`。所以窗口按
 * `[from, from + size - 1]` 写,`to - from` 恒等于 49,999 —— 卡在上限的**下一格**。
 * 别把 `size` 改成报错里那个数字:报错口径是 `to - from`,不是"块数",两口径差一格。
 *
 * 边界:`from > to` → `[]`(不是抛错);`size <= 0` → 抛错(否则 `start += 0`
 * 原地打转,死循环);不整除时最后一格截到 `to`。
 */
function blockWindows(from, to, size) {
  if (size <= 0n) throw new Error(`blockWindows: size 必须为正,收到 ${size}`)
  if (from > to) return []
  const out = []
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n
    out.push({ from: start, to: end > to ? to : end })
  }
  return out
}

/**
 * 扫链找一笔**还没被兑过**的真实付款。
 *
 * ## ⚠️ 关键在"无损探针"
 *
 * 服务端不存报价、KV 里只有"这笔 txHash 用掉了没有"。所以想判断一笔付款还能不能用,
 * 朴素做法是拿它去换内容 —— 而那会**把它消耗掉**。
 *
 * 但这个矩阵里有一条**不消耗凭证**的路:`payment_mismatch`(③ 付款人不是本人)。
 * 它在服务端走的是 `releasePayment`(`api/content/[id].ts` 的 `finally`),
 * **占位会放开**,所以那笔付款原样还在。于是:
 *
 * ```
 * 用一个假地址当 payer 去打 → 403 payment_mismatch  ⇒ 这笔还活着,可用
 *                            → 409 payment_replayed  ⇒ 已经被用掉了,换下一笔
 * ```
 *
 * 探针因此是完全无损的。**扫描只要一个公开地址,不需要私钥。**
 */
async function findLivePayment(payer, activeContentIds) {
  // ⚠️ 从 DEPLOY_BLOCK 起,**但要切窗口** —— 2026-09-24 更正。
  //
  // 这里原来写着「实测公共 Fuji RPC **不限 getLogs 范围**;真被限了就把这里改成
  // 按内容逐个查」。**那个"真被限了"已经发生了**:备端点 `publicnode` 的上限是
  // 50,000 块,而 `DEPLOY_BLOCK → latest` 是 158,401(且只涨不减)。
  //
  // 没有改成"按内容逐个查":那要 N 次请求、N 取决于内容条数,
  // 而切窗口是 4 次、与内容条数无关。做法与网页/服务端**同源**:
  // `shared/blockWindows.ts` 的 `blockWindows()`(纯函数,那边有完整推导)。
  const latest = await publicClient.getBlockNumber()
  const logs = (
    await Promise.all(
      blockWindows(DEPLOY_BLOCK, latest, 50_000n).map((w) =>
        publicClient.getLogs({
          address: SPLITTER,
          event: PAYMENT_SPLIT,
          args: { payer },
          fromBlock: w.from,
          toBlock: w.to,
        }),
      ),
    )
  ).flat() // ⚠️ 按下标拼 ⇒ 全局升序;下面 `reverse()` 取"最新"靠的就是这个顺序

  // 新的排前面 —— 越新越可能还没被兑过
  const seen = new Set()
  const candidates = []
  for (const log of [...logs].reverse()) {
    const txHash = log.transactionHash
    const contentId = log.args.contentId
    if (!txHash || !contentId || seen.has(txHash)) continue
    seen.add(txHash)
    // ⚠️ 只收**在架**内容的付款:下架内容取不到报价(403 content_inactive),
    // 没有报价就没法拼出探针的头,后面那些校验也全都到不了
    if (!activeContentIds.has(contentId.toLowerCase())) continue
    candidates.push({ txHash, contentId })
  }

  for (const c of candidates) {
    const q = await getQuote(c.contentId)
    if (!q.quote) continue
    const probe = await call(`/api/content/${c.contentId}`, {
      header: paymentHeader({
        txHash: c.txHash,
        payer: PROBE_PAYER,
        quoteId: q.quote.quoteId,
        expiresAt: q.quote.expiresAt,
        sig: q.quote.sig,
      }),
    })
    if (probe.status === 403 && probe.body?.error?.code === 'payment_mismatch') {
      return { k: 'found', ...c }
    }

    /**
     * ⚠️ **503 必须单独认出来,不能混进"没找到"。**
     *
     * 探针要走服务端的第 ④ 条(`reservePayment`),而它要 KV。KV 不通时
     * 服务端回的是 `503 upstream_unavailable` —— 跟"这笔付款已经被兑过"
     * 与"这个地址根本没买过"**完全无关**。
     *
     * 2026-09-24 本机实测踩到:这台机器够不到 `*.upstash.io`,于是脚本报出
     * 「没找到可用的付款 … ① 还没买过在架内容」—— 而那笔付款**明明就在链上**,
     * 脚本自己都已经把它扫出来了。**一个验证工具把"验不了"说成"没这回事",
     * 比它不报还坏**:读的人会去重新买一件,而问题根本不在那儿。
     */
    if (probe.status === 503) {
      return { k: 'infra', code: probe.body?.error?.code ?? '?', txHash: c.txHash }
    }

    if (VERBOSE) {
      console.log(`  探针 ${c.txHash.slice(0, 12)}… → ${probe.status} ${probe.body?.error?.code}`)
    }
  }
  return { k: 'none', candidates: candidates.length }
}

/* ──────────────────────────────── 主流程 ──────────────────────────────── */

async function main() {
  console.log(`\n反例矩阵 → ${BASE_URL}\n${'─'.repeat(72)}`)

  // ── 0. catalog ────────────────────────────────────────────────────────
  const catalog = await call('/api/catalog')
  if (catalog.status !== 200 || !Array.isArray(catalog.body?.items)) {
    record('GET /api/catalog 200 + items[]', 'fail', `实得 ${catalog.status} ${JSON.stringify(catalog.body).slice(0, 160)}`)
    return
  }
  const items = catalog.body.items
  const activeContentIds = new Set(items.map((i) => i.contentId.toLowerCase()))
  record(
    'GET /api/catalog 200 + items[]',
    'pass',
    `${items.length} 件在架${items.length ? ` · 最低价 ${items.map((i) => i.price).sort()[0]}` : ''}`,
  )

  /**
   * ⚠️ **只有一条**需要两件在架内容(第 ② 条"拿 A 的报价解 B")。
   * 所以第二件是**可选**的 —— 缺了就跳过那一条,其余照跑。
   *
   * 这不是假想的边界情况:2026-09-24 把老演示内容 `0x6410fb…` 下架之后,
   * 在架的就只剩 `0xe2f8dba7…` 一件,**当时这个脚本就是这么撞上的**。
   * 把"少一件内容"当成前置失败,会让二十条断言一起不跑 —— 而它们本来都能跑。
   */
  const [primary, other = null] = items

  // ── 1. 402 报价形状 ───────────────────────────────────────────────────
  const q = await getQuote(primary.contentId)
  if (!q.quote) {
    record('402 报价', 'fail', `实得 ${q.error.status} ${JSON.stringify(q.error.body).slice(0, 160)}`)
    return
  }
  const quoteFields = ['contentId', 'quoteId', 'expiresAt', 'sig'].every((k) => q.quote[k] !== undefined)
  const accept = q.body.accepts?.[0]
  const shapeOk =
    quoteFields &&
    q.body.x402Version === 1 &&
    q.body.error === 'payment_required' &&
    accept?.payTo?.toLowerCase() === SPLITTER.toLowerCase() &&
    accept?.scheme === 'exact' &&
    accept?.maxTimeoutSeconds === 900
  record(
    '402 报价形状(quote 四字段 + payTo 是合约 + maxTimeoutSeconds=900)',
    shapeOk ? 'pass' : 'fail',
    shapeOk ? `price=${accept.maxAmountRequired}(${primary.price} 链上)` : JSON.stringify(q.body).slice(0, 200),
  )

  // ── 2. 形状类反例(不碰链、不碰 KV,任何环境都该过) ──────────────────────
  expect(
    '第 ⑧ 条:X-Payment 不是 JSON → 400',
    await call(`/api/content/${primary.contentId}`, { header: 'not json' }),
    400,
    'bad_request',
    '⚠️ 它同时证明了"形状早于依赖检查" —— 坏 JSON 不该拿到 403/503',
  )
  expect(
    '第 ⑧ 条:X-Payment 是 {} → 400',
    await call(`/api/content/${primary.contentId}`, { header: '{}' }),
    400,
    'bad_request',
  )
  expect(
    'contentId 形状不对 → 400',
    await call('/api/content/nothex'),
    400,
    'bad_request',
  )
  expect(
    '⚠️ 回归:路径权威,`?id=` 不能顶掉它 → 400',
    await call('/api/content/nothex?id=attacker'),
    400,
    'bad_request',
    '2026-09-23 实测过这个注入:`contentIdFromRequest` 必须只认路径段',
  )
  expect(
    '不存在的 contentId → 404',
    await call('/api/content/0x00000000000000000000000000000000000000000000000000000000deadbeef'),
    404,
    'content_not_found',
  )

  // ── 3. 第 ⑤ 条的签名那一半:改一位就该验不过 ──────────────────────────
  const flipLast = (h) => h.slice(0, -1) + (h.endsWith('a') ? 'b' : 'a')

  expect(
    '第 ⑥ 条:篡改 sig 一位 → 403 quote_invalid',
    await call(`/api/content/${primary.contentId}`, {
      header: paymentHeader({
        txHash: `0x${'11'.repeat(32)}`,
        payer: PAYER ?? PROBE_PAYER,
        quoteId: q.quote.quoteId,
        expiresAt: q.quote.expiresAt,
        sig: flipLast(q.quote.sig),
      }),
    }),
    403,
    'quote_invalid',
  )
  expect(
    '第 ⑥ 条:篡改 expiresAt → 403 quote_invalid',
    await call(`/api/content/${primary.contentId}`, {
      header: paymentHeader({
        txHash: `0x${'11'.repeat(32)}`,
        payer: PAYER ?? PROBE_PAYER,
        quoteId: q.quote.quoteId,
        expiresAt: q.quote.expiresAt + 3600,
        sig: q.quote.sig,
      }),
    }),
    403,
    'quote_invalid',
    '这是"签名保护了 expiresAt"的正面验证 —— 改一位就过不去,第 ⑤ 条才不是空的',
  )
  expect(
    '跨内容复用报价(A 的报价解 B)→ 403 quote_invalid',
    other
      ? await call(`/api/content/${other.contentId}`, {
          header: paymentHeader({
            txHash: `0x${'11'.repeat(32)}`,
            payer: PAYER ?? PROBE_PAYER,
            quoteId: q.quote.quoteId,
            expiresAt: q.quote.expiresAt,
            sig: q.quote.sig,
          }),
        })
      : // 只有一件在架内容时无从验起。给一个**必然对不上**的占位结果,
        // 让下面那条 `skip` 说明原因 —— 而不是伪造一个通过
        null,
    403,
    'quote_invalid',
    other
      ? '签名载荷覆盖 contentId,所以"报价绑定内容"是靠密码学绑的,不是靠服务端记的'
      : '只有一件在架内容,没有第二件可以拿去撞 —— 再建一件就自动会跑',
  )

  // ── 4. 下架 → 403 而不是 402 ──────────────────────────────────────────
  if (INACTIVE_ID) {
    expect(
      '第 ⑩ 条:已下架内容 + 无凭证 → 403 content_inactive(不是 402)',
      await call(`/api/content/${INACTIVE_ID}`),
      403,
      'content_inactive',
      '发 402 等于邀请 agent 花 gas 换一次必然 revert',
    )
  } else {
    record('第 ⑩ 条:已下架内容 → 403 content_inactive', 'skip', '需要 X402_INACTIVE_ID(下架的内容不在 catalog 里,推不出来)')
  }

  // ── 5. 需要一笔真实付款的部分 ─────────────────────────────────────────
  if (!PAYER) {
    record('第 ①~④ 条:需要一笔真实付款', 'skip', '需要 X402_PAYER=0x…(只读地址,不用私钥)')
    report()
    return
  }

  console.log(`\n扫链找 ${PAYER} 发过、且还没被兑过的付款 …`)
  const live = await findLivePayment(PAYER, activeContentIds)

  if (live.k === 'infra') {
    record(
      '第 ①~④ 条:需要一笔真实付款',
      'skip',
      `**验不了,不是没这回事。** 服务端自己回了 503 ${live.code} ——\n` +
        `     KV(或 RPC)不通。第 ④ 条靠 KV 记"这笔用掉了没有",KV 不通就没法验。\n` +
        `     ⚠️ 链上那笔付款是**在**的(脚本扫到了 ${live.txHash.slice(0, 18)}…),别去重买。\n` +
        `     本机的典型原因:\`*.upstash.io\` 偶尔整段不通 —— 见 W7 实施计划 §6.3.3。`,
    )
    report()
    return
  }

  if (live.k === 'none') {
    record(
      '第 ①~④ 条:需要一笔真实付款',
      'skip',
      live.candidates === 0
        ? `${PAYER.slice(0, 10)}… 在**在架**内容上没有付款记录。再买一件就有了。`
        : `扫到 ${live.candidates} 笔,但全被兑过了(KV 里的记录**没有 TTL**,永久)。\n` +
            `     ⚠️ 别再拿它们试 —— 拿旧 txHash 只会得到 409,测不出别的东西。**再买一件。**`,
    )
    report()
    return
  }

  record('找到一笔未被兑过的付款', 'pass', `${live.txHash.slice(0, 18)}… → ${live.contentId.slice(0, 10)}…`)

  // 这笔付款的区块时间 —— 第 ⑦ 条要用它来造一份"确实早于这笔付款"的报价
  const receipt = await publicClient.getTransactionReceipt({ hash: live.txHash })
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  const blockTime = Number(block.timestamp)

  const liveQuote = await getQuote(live.contentId)
  if (!liveQuote.quote) {
    record('为这笔付款取报价', 'fail', `实得 ${liveQuote.error.status}`)
    report()
    return
  }
  const goodHeader = (payer) =>
    paymentHeader({
      txHash: live.txHash,
      payer,
      quoteId: liveQuote.quote.quoteId,
      expiresAt: liveQuote.quote.expiresAt,
      sig: liveQuote.quote.sig,
    })

  // 第 ③ 条 —— 冒用他人 txHash。⚠️ 这条**不消耗**凭证(服务端 releasePayment)
  expect(
    '第 ③ 条:合法 txHash + 别人的 payer → 403 payment_mismatch',
    await call(`/api/content/${live.contentId}`, { header: goodHeader(PROBE_PAYER) }),
    403,
    'payment_mismatch',
    '§16.1「冒用他人 txHash 被拒」',
  )

  // 第 ② 条 —— 拿这笔付款去解**另一件**内容
  expect(
    '第 ② 条:合法 txHash + 另一件内容 → 403 payment_mismatch',
    other && live.contentId.toLowerCase() !== other.contentId.toLowerCase()
      ? await call(`/api/content/${other.contentId}`, { header: goodHeader(PAYER) })
      : null,
    403,
    'payment_mismatch',
    !other
      ? '只有一件在架内容,没有"另一件"可以撞'
      : '⚠️ 注意:换内容之后 path 变了,签名也就对不上了 —— 它可能**先**撞上 quote_invalid。\n' +
        '     真撞上了说明"报价绑定内容"比 ② 更早生效,不是 bug,但这条就验不到 ②。',
  )

  // 第 ⑦ 条 —— 410 quote_expired。需要自签,所以只在本机(有 QUOTE_HMAC_SECRET)能跑
  if (QUOTE_SECRET) {
    const expired = signExpiredQuote(live.contentId, blockTime - 1)
    expect(
      '第 ⑦ 条:付款晚于报价有效期 → 410 quote_expired',
      await call(`/api/content/${live.contentId}`, {
        header: paymentHeader({ ...expired, txHash: live.txHash, payer: PAYER }),
      }),
      410,
      'quote_expired',
      `报价 expiresAt=${blockTime - 1},付款区块时间=${blockTime} —— 差 1 秒,是刻意的`,
    )
  } else {
    record(
      '第 ⑦ 条:410 quote_expired',
      'skip',
      '需要 QUOTE_HMAC_SECRET 自签一份过期报价。它只在本机(vercel dev 的 Development 环境)有。\n' +
        '     ⚠️ 生产上这条**验不了**:要走到第 ⑤ 条必须通过前面的 ④,而 ④ 之后不可能再拿同一笔交易重来。',
    )
  }

  // 第 ① 条 —— 伪造的 txHash
  expect(
    '第 ① 条:伪造 txHash → 404 payment_not_found',
    await call(`/api/content/${live.contentId}`, {
      header: paymentHeader({
        txHash: `0x${'dead'.repeat(16)}`,
        payer: PAYER,
        quoteId: liveQuote.quote.quoteId,
        expiresAt: liveQuote.quote.expiresAt,
        sig: liveQuote.quote.sig,
      }),
    }),
    404,
    'payment_not_found',
    '⚠️ 是 404 不是 503 —— 一个拼错的 txHash 不该得到"我们的服务有问题"',
  )

  // ── 6. 会消耗凭证的两条(默认跳过) ────────────────────────────────────
  if (!BURN) {
    record(
      '第 ① / ④ 条:200 happy path 与 409 payment_replayed',
      'skip',
      '它们会把这笔付款消耗掉(KV 里的记录**没有 TTL**,永久)。加 --burn 才跑。\n' +
        '     ⚠️ 跑之前想清楚:跑完这笔付款就再也兑不了了,得再买一件。',
    )
    report()
    return
  }

  const happy = await call(`/api/content/${live.contentId}`, { header: goodHeader(PAYER) })
  const happyOk =
    happy.status === 200 &&
    typeof happy.body?.url === 'string' &&
    happy.body.url.includes('download=1') &&
    happy.body.expiresInSeconds === AGENT_URL_TTL_SECONDS
  record(
    '第 ① 条:合法凭证 → 200 + 签名 URL',
    happyOk ? 'pass' : 'fail',
    happyOk
      ? `${happy.body.url.slice(0, 64)}… · ${happy.body.expiresInSeconds}s`
      : `实得 ${happy.status} ${JSON.stringify(happy.body).slice(0, 200)}`,
  )

  expect(
    '第 ④ 条:同一 txHash 第二次 → 409 payment_replayed',
    await call(`/api/content/${live.contentId}`, { header: goodHeader(PAYER) }),
    409,
    'payment_replayed',
    '§16.1「同一个 txHash 第二次请求被拒绝」',
  )

  report()
}

function report() {
  const pass = results.filter((r) => r.outcome === 'pass').length
  const fail = results.filter((r) => r.outcome === 'fail').length
  const skip = results.filter((r) => r.outcome === 'skip').length
  console.log(`${'─'.repeat(72)}`)
  console.log(`通过 ${pass} · 失败 ${fail} · 跳过 ${skip}`)
  if (skip) {
    console.log('⚠️ 跳过**不等于**通过 —— 上面每一条跳过的都写了为什么。')
  }
  process.exitCode = fail ? 1 : 0
}

try {
  await main()
} catch (e) {
  console.error(`\n❌ 跑不下去:${e.message}`)
  process.exitCode = 1
}
