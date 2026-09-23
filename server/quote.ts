import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Hex } from 'viem'
import { QUOTE_TTL_SECONDS, type Quote, type SignedQuote } from '../shared/agentPay.js'
import { serverEnv } from './env.js'

/**
 * 402 报价的**签名与验签** —— 方案 §9.4 坑 2「报价必须由服务端签名」的落地。
 *
 * ## 为什么需要它:不签的话第 ⑤ 条校验等于没有
 *
 * 方案的原文说得很直白:
 *
 * > 如果 `quoteExpiresAt` 是 Agent 从 402 响应里自己读、自己回传的裸字段,
 * > 那它**可以随便改** —— 第 5 条校验等于空的。
 *
 * 签名就是堵这个口子的东西。
 *
 * ## ⚠️⚠️ 签名只能覆盖**服务端能重新算出来的**字段 —— 这是本包踩到的一处方案缺口
 *
 * 方案 §9.4 第 609 行给的公式是 `sig = HMAC(secret, contentId + quoteId + expiresAt)`,
 * **恰好就是 agent 会回显的那三项**。我最初擅自往里加了 `amount` 和 `issuedAt`,
 * 结果**签名永远验不过** —— 因为:
 *
 * ```
 * 服务端签的时候知道 amount / issuedAt
 * agent 回显的 X-Payment 里只有 { txHash, payer, quoteId, expiresAt, sig }
 * 而服务端**不存报价**(方案定的"签名即存储")
 *   ⇒ 验签时 amount 与 issuedAt 无从得知 ⇒ 拼不出原文 ⇒ 必然不匹配
 * ```
 *
 * 所以签名载荷**只能是 `contentId + quoteId + expiresAt`**。
 * 方案的版本本来就是自洽的。**要往载荷里加字段,先想清楚验签那一刻它从哪来。**
 *
 * ## 少了 `amount` 和 `issuedAt`,丢了什么?(诚实说)
 *
 * - **`amount` 不用签。** 金额的权威来源是**链**,不是报价:
 *   `pay()` 里 `uint256 amount = c.price`,而 `PaymentSplit` 的 `amounts`
 *   求和恰好等于 `c.price`(余数归最后一位,`distributed` 最终收敛到 `amount`)。
 *   所以路由改成**校验链上那笔分账的总额 == 当前链上价格**,这比"签一个报价里的金额"
 *   **更强** —— 前者是既有事实,后者只是我们自己的声明。
 * - **`issuedAt` 被整个去掉了。** 它原意是给第 ⑤ 条一个下界("交易不能早于报价签发")。
 *   去掉它**反而是好事**,见下。
 *
 * ## ⚠️ 去掉下界之后,第 ⑤ 条变成**只有上界**,而这是对的
 *
 * 第 ⑤ 条现在是 `区块时间 ≤ expiresAt`。下界的**唯一**作用本来是防"拿一笔很久以前
 * 的交易配一份今天的报价" —— 但那个攻击**不存在**:要走到第 ⑤ 条,②③ 已经要求
 * 那是**你本人、为这件内容**发出的 `PaymentSplit`,而 ④ 保证同一个 `txHash`
 * 只能兑一次。也就是说"能通过 ②③ 的交易"本身就意味着"你付过钱了",
 * 再早也只是"你付得早、现在才来取" —— 那是**正当的**,不该拒。
 *
 * 而加了下界会造出一个**真实且不可恢复**的故障(我一度写进计划里,是错的):
 * agent 拿到报价、付了款,但赎回时报价已过期 ⇒ 那笔交易**永远**配不上新报价
 * (新报价的 `issuedAt` 在未来),而合约 `pay()` 第 215 行的 `AlreadyPurchased`
 * 又**不允许重付** ⇒ 钱换了内容,内容拿不到。
 *
 * **现在没有这个问题**:报价过期了,再取一份新的就是 ——
 * 旧交易的 `blockTime` 照样满足 `≤ 新 expiresAt`。**过期不再等于作废。**
 *
 * ## ⚠️ "签名即存储"的代价:报价**无法吊销**
 *
 * 签出去的报价在有效期内一直有效,除非轮换 `QUOTE_HMAC_SECRET`
 * (而那会一次性作废所有未完成的报价)。可以接受 ——
 * 报价里锁的只有 `contentId` 和一个到期时刻,没有金额、没有身份。
 *
 * ## ⚠️ 这个文件在 `server/`,用 `node:crypto`,绝不能进 `shared/`
 *
 * `shared/` 两端共用,浏览器里没有 `node:crypto`。而签名密钥更是只能走
 * `serverEnv()` —— 见 `server/env.ts`:那本登记表是"`VITE_` 前缀会把密钥
 * 内联进前端产物"这条红线**在编译期**的落点。
 */

/**
 * 报价里**进签名的字段拼法** —— 恰好是 `contentId + quoteId + expiresAt`
 * (方案 §9.4 第 609 行的公式)。
 *
 * ⚠️ **只有这三项,不是漏了。** 判据是:**验签那一刻,服务端能不能重新算出来?**
 * 能(这三项里两项来自 `X-Payment` 的回显、一项来自请求路径),才敢签。
 * 加任何一项服务端拿不回来的字段,结果都是**所有签名静默验不过** ——
 * 完整推演见文件头。
 *
 * ⚠️ **字段顺序是签名的一部分,不要重排。** 与 EIP-712 的 `encodeType` 同理:
 * 换了顺序不会报错,只会让**所有已签发的报价静默验不过**。
 *
 * ⚠️ 用 `|` 分隔而不是直接拼接。所有值都是严格 hex 或规范十进制
 * (`parseUint256` 不收前导零),`|` 在它们里**不可能出现**,所以拼接无歧义。
 * 不做分隔的话 `contentId="0xab" + expiresAt="1"` 与
 * `contentId="0xab1" + expiresAt=""` 会撞成同一个串 —— 那是一个能用伪造报价
 * 换到内容的洞。今天这三个字段里 `contentId` 与 `quoteId` 都是定长 32 字节,
 * 撞不上;但**别把"今天撞不上"当成"拼接是安全的"**,那是巧合不是设计。
 */
function quoteSigningPayload(quote: Quote): string {
  return [quote.contentId, quote.quoteId, String(quote.expiresAt)].join('|')
}

/**
 * 密钥。没配就返回 `null` —— 调用方必须当作"服务不可用",**不能跳过验签**。
 *
 * ⚠️ **空串也算"没配"**(2026-09-24 修)。原先写的是 `?? null`,而 `'' ?? null`
 * 得到的是 `''` 不是 `null` —— `??` 只兜 `null`/`undefined`。后果是一条**空值**
 * 被当成"已配置":`quoteConfigured()` 回 `true`,`signQuote` 拿**空密钥**默默签下去,
 * 而它自己的注释写着"密钥缺失时**抛异常**" —— 纪律从这儿被绕过了。
 *
 * 这不是安全漏洞(报价本来就由 402 端点公开派发,伪造一份也换不到内容),
 * 但它让两处判法**自相矛盾**:`serverEnvReady()`(`/api/health` 的 `ready`)和
 * `kvConfigured()` 都用 `Boolean(...)`,空串在那儿是"未配置"。同一个进程里
 * 同一件事有两个答案,是最容易把人带偏的那种不一致。
 *
 * ⚠️ 所以这里**不用 `??`**。判据是"非空"(`truthy`),与 `serverEnvReady` 对齐。
 */
function quoteSecret(): string | null {
  const secret = serverEnv('QUOTE_HMAC_SECRET')
  return secret ? secret : null
}

/** 报价能不能签发 —— `/api/content/:id` 在发 402 之前要问一句 */
export function quoteConfigured(): boolean {
  return quoteSecret() !== null
}

/** 生成一个报价 id。32 字节密码学随机,hex 形态(能过 `isBytes32`) */
export function newQuoteId(): Hex {
  return `0x${randomBytes(32).toString('hex')}`
}

/**
 * 签一份报价。
 *
 * ⚠️ 密钥缺失时**抛异常**而不是返回一个空签名 —— 后者会让一份没签名的报价
 * 流到 agent 手里,而验签那一步如果也恰好宽松,这就是个静默的 fail-open。
 * 抛出来由路由转成 503,是一次**响亮的**失败。
 */
export function signQuote(quote: Quote): SignedQuote {
  const secret = quoteSecret()
  if (!secret) throw new Error('QUOTE_HMAC_SECRET 未配置')
  const sig = createHmac('sha256', secret).update(quoteSigningPayload(quote)).digest('hex')
  return { ...quote, sig: `0x${sig}` }
}

/**
 * 验一份报价的签名。
 *
 * ## ⚠️ 用 `timingSafeEqual`,不用 `===`
 *
 * 字符串比较会在第一个不同的字节上短路返回,把"签名对不对"变成一个
 * **可以逐字节试探的预言机**。虽然 HMAC 的攻击者要构造大量请求才有意义,
 * 但这是个一行就能修掉的东西,没有理由留。
 *
 * 长度不等时 `timingSafeEqual` 会**抛**,所以先比长度。
 * 这里比长度不构成时序泄漏 —— 长度是公开的(HMAC-SHA256 恒为 32 字节)。
 *
 * ## 失败方向
 *
 * 返回 `false` 的三种情况**不区分**:没配密钥、`sig` 形状不对、签名不匹配。
 * 调用方对它们的反应完全一样(拒),区分只会给人一个"这个字段猜对了"的信号。
 */
export function verifyQuote(signed: SignedQuote): boolean {
  const secret = quoteSecret()
  if (!secret) return false

  // `sig` 已在 `parseXPayment` 过 `isBytes32`,但这里可能被别处直接调用 ——
  // 所以自己先兜一次形状,免得 `Buffer.from` 拿到畸形输入后**抛出去变成 500**。
  // ⚠️ 放在算 HMAC **之前**:失败路径要尽可能短,别先干活再判输入。
  if (typeof signed.sig !== 'string' || signed.sig.length !== 66 || !signed.sig.startsWith('0x')) {
    return false
  }

  const expected = createHmac('sha256', secret).update(quoteSigningPayload(signed)).digest()
  const provided = Buffer.from(signed.sig.slice(2), 'hex')
  // HMAC-SHA256 恒为 32 字节,所以这条只是防畸形输入,不会因密钥长度而变
  if (provided.length !== expected.length) return false

  return timingSafeEqual(provided, expected)
}

/**
 * 签发一份新报价 —— 从"现在"起算 `QUOTE_TTL_SECONDS` 秒。
 *
 * ⚠️ **不接受 `amount`** —— 金额不进签名,权威来源是链(见文件头)。
 * 402 响应体里的 `maxAmountRequired` 是**展示用**的,赎回时以链上价格为准。
 *
 * `nowMs` 可注入是为了**能测**:有效期相关的逻辑不能只靠等 15 分钟来验。
 * 单位是**毫秒**,`Date.now()` 就是这个单位。
 */
export function issueQuote(contentId: Hex, nowMs: number = Date.now()): SignedQuote {
  const expiresAt = Math.floor(nowMs / 1000) + QUOTE_TTL_SECONDS
  return signQuote({ quoteId: newQuoteId(), contentId, expiresAt })
}

/**
 * 第 ⑤ 条校验:**这笔付款落在这份报价的有效期内吗**。
 *
 * ⚠️ **只有上界,没有下界 —— 这是刻意的,不是漏了。**
 * 下界(以及为它准备的时钟偏移余量)会造出一个**不可恢复**的故障:
 * agent 付了款但赎回时报价过期 ⇒ 旧交易配不上新报价,而合约的
 * `AlreadyPurchased` 又不允许重付。完整推演见文件头。
 *
 * 去掉下界的代价是**零**:能走到这一步的交易,已经过 ②③ 的"必须是你本人、
 * 为这件内容发起的 `PaymentSplit`",而 ④ 保证它只能兑一次。所以
 * "交易偏早"这个状态**没有对应的攻击者**。
 *
 * ⚠️ 于是第 ⑤ 条在今天的实现里是一条**弱检查** —— 真正承重的是 ②③ 与 ④。
 * 如实说明,别把它包装成"报价有效期的强保护"。
 * 它挡住的是"付款发生在报价过期之后却没重取报价"这一种情况。
 */
export function isWithinQuote(quote: Quote, blockTimeSeconds: number): boolean {
  return blockTimeSeconds <= quote.expiresAt
}

/**
 * 报价自己过没过期。
 *
 * ⚠️ **路由不该在这里拒。** 报价过期只意味着"该取一份新的",
 * 而旧交易在新报价下依然满足 `isWithinQuote`。拿它去拒一个已经付过款的
 * agent,是白让人多跑一个来回 —— 而那正是上面那段要消灭的故障模式的雏形。
 *
 * 留着它是因为 `/api/health` 之类的诊断想知道"一份报价还能用多久",
 * **别在 `deliverBranch` 里拿它当闸门**。
 */
export function isQuoteExpired(quote: Quote, nowMs: number = Date.now()): boolean {
  return Math.floor(nowMs / 1000) > quote.expiresAt
}

/**
 * 从签了名的报价里剥出**进签名的那三个字段**。
 *
 * ⚠️ 剔掉 `sig` 这一步不只是"取子集" —— 它同时保证了
 * **`quoteSigningPayload` 拿到的永远是不含 `sig` 的对象**。
 * 虽然那个函数是按字段名取的(多一个 `sig` 也不影响),但把
 * "签名不能给自己当输入"这件事写在类型上,比写在注释里可靠。
 *
 * 只在**验签通过之后**调用 —— 它不做任何校验。
 */
export function toQuote(signed: SignedQuote): Quote {
  const { contentId, quoteId, expiresAt } = signed
  return { contentId, quoteId, expiresAt }
}
