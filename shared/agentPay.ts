import type { Address, Hex } from 'viem'
import { getAddress, isAddress } from 'viem'
import { UNLOCK_URL_TTL_SECONDS, type UnlockResponse } from './unlock.js'
import { isBytes32, parseUint256, parseStringFields } from './eip712.js'

/**
 * Agent 付款路径的**线上格式** —— 402 报价、`X-Payment` 凭证、catalog 列表。
 *
 * 只放**形状与常量**,不放任何密码学:HMAC 的签与验在 `server/quote.ts`
 * (那边要 `node:crypto`,而本文件两端共用,不能碰 Node 内置模块)。
 *
 * ## ⚠️ 我们对 x402 的立场:**复用形态,不实现结算**(2026-09-23 决策 B)
 *
 * 报价体、字段命名、`method` 都照着 x402 来,让认这个标准的评委一眼看得懂。
 * 但**结算不是 x402**:x402 的 `exact` scheme 是 payer 用 EIP-3009
 * `transferWithAuthorization`(或 Permit2)**直付 `payTo`**、由 facilitator 广播;
 * 我们走的是买家自己调 `CreatorSplitter.pay(contentId)`。
 *
 * 两者**信任模型正好相反**,所以 README 与本文档只能声明
 * 「**复用 x402 的交互形态与报价字段命名**」,不能声明"实现了 x402"。
 * 完整推演见 `docs/W7-实施计划.md` §〇。**别把这里的字段名当成"我们兼容 x402"的证据。**
 *
 * ## ⚠️ 本文件两端共用
 *
 * 不许出现 `process.env`(浏览器里没有)、不许出现 `node:*`(Vercel 的函数可以,
 * 但前端不行)、不许出现 `import.meta`(Node 里没有)。
 */

/* ───────────────────────────── 常量 ───────────────────────────── */

/**
 * x402 的版本号。**用 V1 的形态**。
 *
 * ⚠️ 这是刻意的,不是没跟上:v2 把报价放进 `PAYMENT-REQUIRED` **响应头**、
 * 认证头改名 `PAYMENT-SIGNATURE`、金额字段改名 `amount`。
 * 我们选的 V1 形态(`X-Payment` 头 + 响应体里的 `accepts[]` + `maxAmountRequired`)
 * 与方案 §9.4 的原文更贴,而且**V1 仍然被 SDK 接受**。
 * 想升 V2 的话,三个地方要一起改,别只改这个数字。
 */
export const X402_VERSION = 1

/** CAIP-2 格式的链标识 —— x402 用它,不是裸的 chainId */
export const CAIP2_NETWORK = 'eip155:43113'

/**
 * Agent 要调的方法签名。**人类与 Agent 共用同一个 `pay()`** ——
 * 这正是方案 §9.4 说的"v2.1 的改动全部落在 HTTP 层、合约零改动"。
 */
export const AGENT_PAY_METHOD = 'pay(bytes32)'

/**
 * 报价有效期(秒)。**15 分钟,不是 60 秒。**
 *
 * ⚠️ 这个数字直接决定"付了钱能不能拿到内容",别按直觉调小:
 * agent 拿到 402 之后要**发两笔交易**(`approve` + `pay`)、等两次上链,
 * 再加 RPC 抖动。有效期太短的失败模式是 agent 已经付了钱、
 * 重试时却被告知报价过期 —— **钱花了,东西拿不到**,而且演示现场不可恢复。
 *
 * 定长了有没有坏处?有,但很小:报价里锁着 `amount`,有效期越长,
 * 一个旧报价能用的时间越久。演示场景价格是固定的,这个代价可以忽略。
 * (方案 §9.4 第 599 行要求"已用要记在成功响应之后"是同一个考虑的另一个侧面。)
 */
export const QUOTE_TTL_SECONDS = 15 * 60

/** `X-Payment` 请求头名。V1 的名字,V2 叫 `PAYMENT-SIGNATURE` */
export const PAYMENT_HEADER = 'X-Payment'

/* ───────────────────────────── 报价 ───────────────────────────── */

/**
 * 报价的**计算形态** —— 恰好是进签名的那三个字段,一个不多一个不少。
 *
 * ## ⚠️ 为什么**没有** `amount` 和 `issuedAt`(本包踩到的一处方案缺口)
 *
 * 判据是:**验签那一刻,服务端能不能重新把这些字段算出来?**
 *
 * ```
 * 服务端签报价时:知道 amount / issuedAt
 * agent 回显的 X-Payment:{ txHash, payer, quoteId, expiresAt, sig }
 * 服务端**不存报价**(方案定的"签名即存储")
 *   ⇒ 验签时 amount 与 issuedAt 无从得知 ⇒ 拼不出签名原文 ⇒ 必然不匹配
 * ```
 *
 * 而 `contentId`(来自请求路径)、`quoteId` 与 `expiresAt`(来自回显)都拿得回来。
 * 所以载荷就是方案 §9.4 第 609 行原本写的 `contentId + quoteId + expiresAt`
 * —— **那一版是自洽的,是我擅自加字段才把它弄崩的。**
 * 要往载荷里加东西,先回答"验签那一刻它从哪来"。
 *
 * **丢了什么**:
 * - 金额不再由报价背书 → 改成赎回时**核对链上那笔分账的总额 == 当前链上价格**。
 *   更硬:那是既有事实,不是我们自己的声明。
 * - `issuedAt` 整个去掉,连第 ⑤ 条的下界一起 —— 那**修掉了一个不可恢复的故障**,
 *   详见 `server/quote.ts` 文件头。
 */
export type Quote = {
  /** 32 字节随机,同时也是 `X-Payment` 里 agent 要回显的那个 */
  quoteId: Hex
  contentId: Hex
  /**
   * unix 秒。**唯一的时限,而且是「上界」**:
   * 第 ⑤ 条 = `付款区块时间 ≤ expiresAt`。
   *
   * ⚠️ 报价过期**不等于作废** —— 再取一份新的就是,旧交易在新报价下照样通过。
   * 别在服务端拿"报价过期"去拒一个已经付过款的 agent
   * (理由:合约的 `AlreadyPurchased` 让 agent 无法重付,拒了就没有退路)。
   */
  expiresAt: number
}

/** 签了名的报价 —— 402 响应体里 `quote` 字段的形状 */
export type SignedQuote = Quote & { sig: string }

/**
 * 402 响应体(x402-V1 形态 + 我们的签名报价)。
 *
 * ⚠️ `error` 是**字符串** `"payment_required"`,不是仓库那个
 * `{ error: { code, message } }` 信封 —— 与方案 §9.4 原文一致。
 * **只有 402 长这样**,其余错误一律走仓库信封(`shared/api.ts`)。
 * 两种形状并存是刻意的:402 是 x402 握手,别的都是我们自己的错误。
 *
 * ⚠️ `ApiErrorCode` 里**没有** `payment_required`,也不该加 ——
 * 它不是一个客户端要分支的"失败原因",而是"请开始付款"这个正常流程的一步。
 */
export type PaymentRequiredBody = {
  x402Version: number
  error: 'payment_required'
  accepts: Array<{
    scheme: 'exact'
    network: string
    /**
     * ⚠️ **V1 的字段名**(V2 叫 `amount`)。
     * 值是**原始单位**的十进制字符串,不是 `"0.05"` —— 缩放交给客户端,
     * 因为它得先读 `decimals`。少一次浮点转换就少一类"钱算错了"的 bug。
     */
    maxAmountRequired: string
    /** `CreatorSplitter` 合约地址。**不是**收款人的地址 —— 见文件头"结算不是 x402" */
    payTo: Address
    /** USDC 合约地址 */
    asset: Address
    /** 这次请求的完整 URL */
    resource: string
    mimeType: string
    maxTimeoutSeconds: number
    /**
     * ⚠️ `assetTransferMethod` **故意不写 `eip3009`**。
     *
     * 我们**没有**实现 ERC-3009 代付(见文件头)。写成 `eip3009` 就是撒谎,
     * 而且会让按标准实现的客户端去做一件我们服务端根本不认的事。
     * `eip3009-or-approve` 如实说明:买家自己持有 USDC,
     * 走 `approve` + `pay` 两笔(与人类路径同一条)。
     */
    extra: { name: string; version: string; assetTransferMethod: string }
  }>
  contentId: Hex
  method: string
  quote: SignedQuote
}

/* ────────────────────────── 内容响应 ────────────────────────── */

/**
 * 带凭证访问成功时的响应体。
 *
 * ⚠️ **与人类路径逐字一致 —— 这是 `UnlockResponse` 的类型别名,不是一份新定义。**
 *
 * 写成别名(而不是复制一遍字段)是**有意的**:两条路径交付的是同一个东西
 * (一条 60 秒的私有 blob 短时效 URL),用同一个类型就等于让"它们必须一致"
 * 变成**编译器保证的事**,而不是靠两边各写一遍、靠人记得同步。
 *
 * 想改形状?那必然是两条路径一起改 —— 如果只想改一条,先想清楚为什么
 * 同一份内容会有两种交付方式。
 */
export type AgentContentResponse = UnlockResponse

/** 交付的 URL 有效期 —— 直接沿用人类路径的值,别另立一个 */
export const AGENT_URL_TTL_SECONDS = UNLOCK_URL_TTL_SECONDS

/* ───────────────────────────── catalog ───────────────────────────── */

/** 列表里的一条。字段名与方案 §9.4 的 `GET /api/catalog` 原文一致 */
export type CatalogEntry = {
  contentId: Hex
  /**
   * ⚠️ 可能是 `null` —— 链上**不存标题**,服务端的唯一来源是 KV。
   * 而这个 KV 记录由 `POST /api/content-meta` 写入,**在它存在之前创建的内容没有。**
   * 返回 `null` 而不是空字符串:`""` 会让人分不清"没标题"和"标题是空的"。
   */
  title: string | null
  /** 原始单位的十进制字符串,同 `maxAmountRequired` */
  price: string
  currency: 'USDC'
  decimals: number
  chainId: number
  creator: Address
  /** 预览图的完整公开 URL。没传预览图时是 `null` */
  previewUrl: string | null
}

/** `GET /api/catalog` 的响应体 */
export type CatalogResponse = {
  items: CatalogEntry[]
  /** 这份列表是**哪个区块高度**上的 —— 便于排查"刚创建的内容没出现" */
  blockNumber: string
}

/* ───────────────────────── `X-Payment` 凭证 ───────────────────────── */

/**
 * `X-Payment` 头里装的凭证。
 *
 * ## ⚠️ 它装的是**已广播交易的哈希**,而真 x402 装的是**未广播的签名授权**
 *
 * 这是本方案与 x402 最本质的差别,也是"不能声称实现了 x402"的**主要证据**:
 *
 * ```
 * 真 x402 :  X-PAYMENT = 一条 EIP-3009 签名授权  → facilitator 拿去广播
 * 我们    :  X-Payment = { txHash, … }           → 交易早就在链上了,我们只去查证
 * ```
 *
 * 我们这么做是因为 `pay()` 的 `msg.sender` 必须是买家本人
 * (`CreatorSplitter.sol:223`),facilitator 代付会直接破坏那个语义。
 */
export type XPaymentWire = {
  /** 32 字节交易哈希 */
  txHash: string
  /** 付款人地址。必须与链上 `PaymentSplit` 事件里的 `payer` 一致 */
  payer: string
  /** 回显 402 里那个报价的 id */
  quoteId: string
  /** 回显报价的过期时刻。**它进签名**,所以改一位就验不过 —— 见下面那段 */
  expiresAt: string
  /** 服务端对整份报价做的 HMAC */
  sig: string
}

/* ───────────────────────────── 解析 ───────────────────────────── */

/**
 * 解析 `X-Payment` 头的值。**任何形状问题一律返回 `null`,绝不抛。**
 *
 * 理由同 `shared/eip712.ts` 的解析原语:这个字符串完全由客户端控制,
 * 未捕获的异常就是 500,而 500 对 agent 来说没有任何可操作性。
 *
 * ## ⚠️ 为什么 `expiresAt` 也要 agent 回显(方案原文没写这一条)
 *
 * 方案 §9.4 的坑 2 定的是**"签名即存储"** —— 服务端**不落 KV 记录报价签发时间**
 * (`{ contentId, price, …, quoteId, expiresAt, sig }`,验签 sig 才采信 `expiresAt`)。
 * 而验签需要 `expiresAt` 的原文。所以它必须跟着回来。
 *
 * 这样 agent **改不了** `expiresAt`:HMAC 覆盖了它,改一位就验签失败。
 * 这就是第 ⑤ 条校验"报价必须由服务端签名,否则本条无法验证"的落地方式。
 *
 * ⚠️ 四道形状检查里 `sig` 用的是 `isBytes32`(HMAC-SHA256 = 32 字节),
 * 不是 `isStandardSignature`(那是 65 字节的 ECDSA)—— 两者**不一样,别用混**。
 */
export function parseXPayment(raw: string | null): XPaymentWire | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const fields = parseStringFields(parsed, ['txHash', 'payer', 'quoteId', 'expiresAt', 'sig'])
  if (!fields) return null

  const { txHash, payer, quoteId, expiresAt, sig } = fields
  if (!isBytes32(txHash)) return null
  if (!isBytes32(quoteId)) return null
  // HMAC-SHA256 是 32 字节 —— 与 65 字节的 ECDSA 签名不同,用错原语会让
  // "长度不对"变成一个静默的验签失败
  if (!isBytes32(sig)) return null
  if (parseUint256(expiresAt) === null) return null
  // ⚠️ 非 strict 的 `isAddress`:strict 是"校验 checksum",会拒掉合法的小写地址
  if (!isAddress(payer)) return null

  // 地址归一化成 checksum 形态 —— 理由与 `parseUnlockWire` 完全相同:
  // 下游要拿它做**大小写敏感的字符串比较**(比对链上事件里的 payer),
  // 不归一化的话一个全小写的地址会把"本人"判成"别人"。
  return {
    txHash,
    payer: getAddress(payer.toLowerCase() as Address),
    quoteId,
    expiresAt,
    sig,
  }
}
