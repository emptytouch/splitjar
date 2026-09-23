import { getDownloadUrl, issueSignedToken, presignUrl } from '@vercel/blob'
import type { Hex } from 'viem'
import {
  AGENT_PAY_METHOD,
  AGENT_URL_TTL_SECONDS,
  CAIP2_NETWORK,
  PAYMENT_HEADER,
  QUOTE_TTL_SECONDS,
  X402_VERSION,
  parseXPayment,
  type AgentContentResponse,
  type PaymentRequiredBody,
  type SignedQuote,
} from '../../shared/agentPay.js'
import { errorResponse } from '../../shared/api.js'
import { USDC } from '../../shared/chain.js'
import { contentPathname, isContentId } from '../../shared/storage.js'
import { getContentInfo, getPaymentSplits, SPLITTER_ADDRESS } from '../../server/chain.js'
import { serverEnv } from '../../server/env.js'
import { commitPayment, kvConfigured, releasePayment, reservePayment } from '../../server/kv.js'
import { isWithinQuote, issueQuote, quoteConfigured, verifyQuote } from '../../server/quote.js'

/**
 * `GET /api/content/:contentId` —— Agent 买内容的那一个端点(方案 §9.4)。
 *
 * ## 两条路,靠**有没有 `X-Payment` 头**分流
 *
 * ```
 * 没有 X-Payment  → 402 + 一份签了名的报价        (方案第 1 步:报价)
 * 有   X-Payment  → 五条校验 → 200 + 短时效 URL   (方案第 3 步:交付)
 * ```
 *
 * ## ⚠️ 顺序是有讲究的:必须**先看头、再读链**
 *
 * 第 ② 步(有没有凭证)**必须早于** 判内容在不在售。理由是**已下架内容的
 * 已购买家仍然要能取到内容** —— 下架不影响已购(`/api/unlock` 的六道检查里
 * 没有任何一步看 `active`,这是刻意的,见方案 §12.5)。
 *
 * 反过来写就会造出一个真 bug:一个**付过钱**的人被挡在门外。
 *
 * ## ⚠️ 已下架 → **403,不是 402**
 *
 * 给一个已下架的内容发 402 报价,等于**邀请 agent 去花 gas 换一次必然的 revert**
 * —— 合约 `pay()` 第三行就是 `if (!c.active) revert ContentInactive(contentId)`
 * (`CreatorSplitter.sol:214`)。人类付费页早就把这条路堵上了
 * (`src/lib/payGate.ts` 的 `content-inactive`),服务端不能反而敞开。
 *
 * 方案 §9.4 **没有规定**这一条,是本包定的(见 `docs/W7-实施计划.md` §三)。
 *
 * ## 第 ①②③ 条塌缩成一次读
 *
 * 见 `server/chain.ts` 的 `getPaymentSplits`:收据成功 + `PaymentSplit` 日志在场
 * 就同时满足了"已上链且成功""`contentId` 一致""`payer` 一致"。方案原文写的
 * 「确认数达标」**没有规定数字**,这里换成确定性判据,**代价是没有 reorg 保护**
 * —— 上主网前必须改。
 */
/**
 * ⚠️ **具名 `GET`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 */
export async function GET(request: Request): Promise<Response> {
  const contentId = contentIdFromRequest(request)
  if (!contentId) {
    return errorResponse(400, 'bad_request', 'contentId 形状不对')
  }

  const rawPayment = request.headers.get(PAYMENT_HEADER)

  // ⚠️ 分流的**位置**是关键,理由见文件头
  return rawPayment === null
    ? await quoteBranch(request, contentId)
    : await deliverBranch(contentId, rawPayment)
}

/**
 * 从**路径**里取出 contentId。
 *
 * ## ⚠️ 为什么不用 `searchParams`,尽管 Vercel 确实会注入 `?id=`
 *
 * 因为那个注入**可以被客户端顶掉**。2026-09-23 在 `vercel dev` 上实测:
 *
 * ```
 * GET /api/content/onchain             → search = "?id=onchain"     ← 注入的
 * GET /api/content/onchain?id=attacker → search = "?id=attacker"    ← 注入消失了!
 * ```
 *
 * 客户端只要自己带一个 `?id=`,路径段就**永远不会**被注入。读
 * `searchParams.get('id')` 等于把"用哪件内容"交给客户端随口一说 ——
 * 虽然它本来就能请求任意路径(所以不构成越权),但那会让**日志、报价里的
 * `contentId`、以及响应对应的资源三者对不上**,排查时能把人绕死。
 *
 * 路径是**权威的**:它就是调用方真正请求的那个资源。
 *
 * ## 只收单段
 *
 * `/api/content/a/b` 在 Vercel 上本来就 404(已实测),但这里也不接受 ——
 * 免得将来路由配置一改,这个函数对多段路径给出意外行为。
 */
function contentIdFromRequest(request: Request): Hex | null {
  const { pathname } = new URL(request.url)
  const PREFIX = '/api/content/'
  if (!pathname.startsWith(PREFIX)) return null

  const rest = pathname.slice(PREFIX.length)
  // 空 / 多段 / 带斜杠一律不认。**刻意不 decodeURIComponent**:
  // contentId 是纯 hex,不需要解码,而 `decodeURIComponent` 对畸形 `%` 转义
  // 会**抛异常**(未捕获的异常就是 500)。少一个会抛的调用就少一类 500。
  if (!rest || rest.includes('/')) return null

  return isContentId(rest) ? rest : null
}

/* ────────────────── 第 1 步:没凭证 → 402 + 签名报价 ────────────────── */

async function quoteBranch(request: Request, contentId: Hex): Promise<Response> {
  if (!quoteConfigured()) {
    // 密钥没配就**绝不能往下走** —— 一份没签名的报价流出去,第 ⑤ 条就废了
    return errorResponse(503, 'not_configured', '服务端未配置报价签名')
  }

  let info: Awaited<ReturnType<typeof getContentInfo>>
  try {
    info = await getContentInfo(contentId)
  } catch {
    // 读不到 ≠ 不存在。见 server/chain.ts 的拦截说明
    return errorResponse(503, 'upstream_unavailable', '链上查询暂时不可用')
  }
  if (info === null) {
    return errorResponse(404, 'content_not_found', '这份内容不存在')
  }
  // ⚠️ 403 而不是 402 —— 见文件头
  if (!info.active) {
    return errorResponse(403, 'content_inactive', '这份内容已下架')
  }

  // ⚠️ 这里**不需要**判 `price === 0`。合约 `createContent` 第 152 行是
  // `if (price == 0) revert PriceMustBePositive();` —— 零价内容**创建不出来**。
  // 加一条永远为假的检查只会让人以为"零价是可能的"。
  const quote = issueQuote(contentId)

  const url = new URL(request.url)
  return Response.json(
    {
      x402Version: X402_VERSION,
      error: 'payment_required',
      accepts: [
        {
          scheme: 'exact',
          network: CAIP2_NETWORK,
          // 原始单位(6 位小数)的十进制字符串。缩放到 `decimals` 位是客户端的事
          maxAmountRequired: info.price.toString(),
          // ⚠️ 是**合约地址**,不是收款人地址 —— 钱由合约内的分账循环分给 N 方,
          // 而 x402 的 `exact` scheme 只有单 payee,容纳不下(见 shared/agentPay.ts 文件头)
          payTo: SPLITTER_ADDRESS,
          asset: USDC.address,
          resource: `${url.origin}${url.pathname}`,
          mimeType: 'application/json',
          // 与报价有效期**同一个数** —— 别在这里另写一个值
          maxTimeoutSeconds: QUOTE_TTL_SECONDS,
          extra: {
            name: 'USDC',
            version: '2',
            // ⚠️ 故意不写 `eip3009`:我们**没有**实现 ERC-3009 代付。
            // 买家自己持币,走 approve + pay 两笔 —— 与人类路径同一条
            assetTransferMethod: 'eip3009-or-approve',
          },
        },
      ],
      contentId,
      method: AGENT_PAY_METHOD,
      quote,
    } satisfies PaymentRequiredBody,
    { status: 402 },
  )
}

/* ─────────────── 第 3 步:带凭证 → 五条校验 → 交付 ─────────────── */

async function deliverBranch(contentId: Hex, rawPayment: string): Promise<Response> {
  // ── 形状(**排在依赖检查之前**)────────────────────────────────────────
  //
  // ⚠️ **顺序是有讲究的,别把这段挪到下面去**(2026-09-23 定的)。
  //
  // `parseXPayment` 是**纯函数**:不碰网络、不碰密钥、读不到 KV 也照样能判。
  // 所以先做它永远不会有更差的答案,而且能立刻告诉调用方"错在你的请求里"。
  //
  // 反过来写(先查依赖)的症状:KV 抖动时一个**完全合法的**凭证
  // 与一个**坏 JSON** 返回**同一个** 503 `not_configured`,请求错在哪一句不说。
  // 本机实测过这个症状 —— 见 `docs/W7-实施计划.md` §6.1 那行 503。
  const wire = parseXPayment(rawPayment)
  if (!wire) {
    return errorResponse(400, 'bad_request', `${PAYMENT_HEADER} 形状不对`)
  }
  const txHash = wire.txHash as Hex

  // ── 依赖检查 ──────────────────────────────────────────────────────────
  if (!quoteConfigured()) {
    // ⚠️ 必须早于 `verifyQuote` —— 密钥没配时 `verifyQuote` 会返回 `false`,
    // 于是我们会对一份**其实没问题**的报价回 403 `quote_invalid`。
    // 那是在撒谎:报价没错,是我们自己没配好
    return errorResponse(503, 'not_configured', '服务端未配置报价签名')
  }
  if (!kvConfigured()) {
    // ⚠️ 没有 KV 就**没有防重放**,必须拒 —— 不能退化成"跳过第 ④ 条"
    return errorResponse(503, 'not_configured', '服务端未配置付款凭据存储')
  }
  const blobToken = serverEnv('BLOB_READ_WRITE_TOKEN')
  if (!blobToken) {
    return errorResponse(503, 'not_configured', '服务端未配置内容存储')
  }

  // ── 第 ⑤ 条的**签名那一半**:这份报价是不是我们签的 ─────────────────
  // ⚠️ `contentId` 用**请求路径**里的那个,不是 `X-Payment` 里的
  // (`X-Payment` 里压根没有这个字段)。签名载荷覆盖 `contentId + quoteId + expiresAt`,
  // 所以拿 A 内容的报价来解锁 B 内容,在这里就验不过 —— 这正是"报价绑定内容"的落点。
  const quoted: SignedQuote = {
    contentId,
    quoteId: wire.quoteId as Hex,
    expiresAt: Number(wire.expiresAt),
    sig: wire.sig,
  }
  if (!verifyQuote(quoted)) {
    // 三种情况在这里不可区分,也不需要区分:没配密钥 / `expiresAt` 被改过 /
    // 这份报价根本不是我们签的。见 server/quote.ts 的失败方向说明
    return errorResponse(403, 'quote_invalid', '报价无效或已被篡改')
  }

  // ── 第 ④ 条:原子占位(方案要求"KV 写入要原子") ─────────────────────
  // ⚠️ 放在链上读**之前** —— 否则两个并发请求会双双做完 RPC 才发现撞车。
  // 但这只是一个**短租约**(60 秒),不是最终落定:成功才 `commitPayment`,
  // 中途任何失败都在下面的 `finally` 里 `releasePayment`。
  // 这样"原子"和"已用要记在成功响应之后"两条要求才能同时成立。
  let reserved: boolean
  try {
    reserved = await reservePayment(txHash, contentId)
  } catch {
    return errorResponse(503, 'upstream_unavailable', '付款凭据服务暂时不可用')
  }
  if (!reserved) {
    // 要么真的用过了,要么另一个并发请求正在处理它。两种都是"拒",不必区分
    return errorResponse(409, 'payment_replayed', '这笔交易已经被用过了')
  }

  // ⚠️ 从这里开始,**每一条失败路径都必须放开占位**,否则 agent 会撞上
  // 一个 60 秒的假"已用过"。用一个 `finally` 兜住,而不是在每个 `return`
  // 前面手写一次 —— 手写一定会漏掉某一条(新增分支时最容易忘)。
  let committed = false
  try {
    // ── 第 ①②③ 条:一次收据读 ─────────────────────────────────────────
    let splits: Awaited<ReturnType<typeof getPaymentSplits>>
    try {
      splits = await getPaymentSplits(txHash)
    } catch {
      // ⚠️ 交易不存在时 viem 会**抛**(`TransactionReceiptNotFoundError`),
      // 所以"没有这笔交易"和"RPC 挂了"在 catch 里分不开 —— 但两者都返回
      // **同一条 404**,因为对 agent 来说出路一样(检查你的 txHash / 等节点追上)。
      // ⚠️ 别把它写成 503:一个拼错的 txHash 会得到"我们的服务有问题"这种误导。
      return errorResponse(404, 'payment_not_found', '链上找不到这笔交易')
    }
    if (splits === null || splits.length === 0) {
      // 收据 `status !== 'success'`,或者那笔交易里根本没有分账事件
      return errorResponse(404, 'payment_not_found', '这笔交易没有成功分账')
    }

    // ② + ③:必须是**这件内容**、且付款人是**这个地址**
    const match = splits.find(
      (s) =>
        s.contentId.toLowerCase() === contentId &&
        s.payer.toLowerCase() === wire.payer.toLowerCase(),
    )
    if (!match) {
      // 三种情况合并:交易付的是别的内容 / 交易是别人付的 / 两者都不是。
      // **合并成一条是刻意的** —— 区分开会变成一个"这个 txHash 存在吗"的
      // 预言机,让冒用者能靠错误码逐个试出别人的交易哈希。
      return errorResponse(403, 'payment_mismatch', '这笔交易与请求的内容或付款人不符')
    }

    // ── 金额:核对链上那笔分账的总额 == 当前链上价格 ─────────────────────
    // ⚠️ 这是**替代**"把 amount 签进报价"的那条路。理由:金额的权威来源是链。
    // `pay()` 里 `uint256 amount = c.price`,而 `amounts` 的余数归最后一个
    // 收款人,`distributed` 最终恰好收敛到 `amount` —— 所以这里求和必然等于价格。
    // 比"签一个我们自己声明的金额"更硬。
    //
    // ⚠️ **如实说明:今天这条检查不可能失败。** `createContent` 之后再没有
    // 任何改价的入口(已从 ABI 核实),所以链上价格恒等于付款时的价格。
    // 留着它是因为"金额不被验证"这件事本身不可接受 —— 将来如果合约允许改价,
    // 这条就是唯一会拦住"拿旧价付款换新价内容"的东西。
    let info: Awaited<ReturnType<typeof getContentInfo>>
    try {
      info = await getContentInfo(contentId)
    } catch {
      return errorResponse(503, 'upstream_unavailable', '链上查询暂时不可用')
    }
    if (info === null) {
      // 有 `PaymentSplit` 却读不到内容 —— 合约没有删除入口,所以这不该发生。
      // 真发生了就当"这笔付款对不上",别放行
      return errorResponse(403, 'payment_mismatch', '这笔交易与请求的内容不符')
    }
    const paid = match.amounts.reduce((sum, v) => sum + v, 0n)
    if (paid !== info.price) {
      return errorResponse(403, 'payment_mismatch', '这笔交易的金额与当前价格不符')
    }

    // ── 第 ⑤ 条:付款落在这份报价的有效期内吗 ──────────────────────────
    // ⚠️ **只有上界**,没有下界 —— 那是刻意的,详见 server/quote.ts 文件头。
    // 简言之:下界会造出一个"付了款却永久拿不到"的故障,而它并没有对应的攻击者。
    const quote = { contentId, quoteId: quoted.quoteId, expiresAt: quoted.expiresAt }
    if (!isWithinQuote(quote, match.blockTimeSeconds)) {
      return errorResponse(410, 'quote_expired', '这笔付款发生在这份报价的有效期之外')
    }

    // ── 交付:签发 60 秒短时效 URL ──────────────────────────────────────
    //
    // 与 `api/unlock.ts` 的尾段**逐字相同** —— 两条路径交付的是同一个东西,
    // 用同一个原语就等于让"它们必须一致"变成**编译器保证的事**
    // (类型上也绑在一起:`AgentContentResponse` 是 `UnlockResponse` 的别名)。
    // ⚠️ 用 `contentPathname()` **重算**路径,不接受客户端给的任何路径片段。
    const pathname = contentPathname(contentId)
    const validUntil = Date.now() + AGENT_URL_TTL_SECONDS * 1000

    let url: string
    try {
      const signed = await issueSignedToken({
        token: blobToken,
        pathname,
        operations: ['get'],
        validUntil,
      })
      const { presignedUrl } = await presignUrl(signed, {
        operation: 'get',
        pathname,
        access: 'private',
        validUntil,
        useCache: false,
      })
      // ⚠️ 必须再过一遍 `getDownloadUrl` —— 它往 query 里塞 `download=1`,
      // 让响应带上 `Content-Disposition: attachment`。少了它浏览器会内联打开。
      // 来龙去脉见 `api/unlock.ts` 那段注释与方案 §20.4.5.1
      url = getDownloadUrl(presignedUrl)
    } catch {
      return errorResponse(503, 'upstream_unavailable', '内容存储暂时不可用')
    }

    // ── 第 ④ 条的后半:落定 ─────────────────────────────────────────────
    // ⚠️ **必须在返回之前**,而且失败就不返回 URL。
    // 如果落定失败却把 URL 发出去了,那个占位 60 秒后会自己过期,
    // 这笔交易就重新变得可兑 —— 一次真实的重放。宁可让 agent 拿到 503 重试。
    try {
      await commitPayment(txHash, contentId)
    } catch {
      return errorResponse(503, 'upstream_unavailable', '付款凭据服务暂时不可用')
    }
    committed = true

    return Response.json({
      url,
      expiresInSeconds: AGENT_URL_TTL_SECONDS,
    } satisfies AgentContentResponse)
  } finally {
    if (!committed) {
      // 放开租约,让 agent 能**原样重试**。这里吞掉异常是刻意的:
      // 它跑在 `finally` 里,抛出去会盖掉上面那个更有意义的响应
      await releasePayment(txHash).catch(() => {})
    }
  }
}
