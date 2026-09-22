import { getDownloadUrl, issueSignedToken, presignUrl } from '@vercel/blob'
import { recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { contentPathname } from '../shared/storage.js'
import {
  toUnlockMessage,
  parseUnlockWire,
  unlockTypedData,
  UNLOCK_URL_TTL_SECONDS,
  type UnlockResponse,
} from '../shared/unlock.js'
import { hasPurchased, SPLITTER_ADDRESS } from '../server/chain.js'
import { serverEnv } from '../server/env.js'
import { errorResponse } from '../shared/api.js'
import { consumeNonce, kvConfigured, peekNonce } from '../server/kv.js'

/**
 * `POST /api/unlock` —— 付费门禁(方案 §9.2)。
 *
 * ## 六道检查,顺序是有讲究的
 *
 * ```
 * ① 形状      parseUnlockWire            畸形输入 → 400(不能变成 500)
 * ② 签名      recover == 买家            伪造 → 401
 * ③ 时效      deadline > now            过期 → 401
 * ④ nonce     peekNonce == contentId    重放 / 错配 → 401
 * ⑤ 付款      链上 purchases            没买 → 402
 * ⑥ 用掉      consumeNonce              并发重放 → 409
 * ```
 *
 * ## ⚠️ 第 ⑥ 步必须是**最后**一步,而且必须在返回之前
 *
 * 方案 §9.2 记了一条教训:
 *
 * > **先删再干活,后面失败用户就得重新签名。**
 *
 * 所以 nonce 的删除放在所有检查都过完之后 —— 中途任何一步失败都**不动 nonce**,
 * 用户可以原样重试。反过来(进门就删)会让一次 RPC 抖动变成一个
 * "你必须重新签一次名"的用户体验,而用户完全不知道为什么。
 *
 * 而它又必须在**返回响应之前** —— 否则两个并发请求会双双通过第 ④ 步
 * 拿到同一个 nonce 的下载链接,防重放就白做了。`consumeNonce` 内部是
 * **原子的 `DEL`**:谁先删掉谁得 `true`,后到的得 `false`,这一步就是
 * 并发下的收敛点。
 *
 * ## ⚠️ 失效方向
 *
 * 第 ④ 步"看一眼"和链上查询**都不吞异常**:
 * KV 读不到 → 503(不是 401),RPC 读不到 → 503(不是 402)。
 * 把"读不到"当成"没买"会让一次上游抖动变成"用户明明买了却被告知没买",
 * 而那种 bug 在演示现场是灾难性的。
 */
/**
 * ⚠️ **具名 `POST`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 */
export async function POST(request: Request): Promise<Response> {
  if (!kvConfigured()) {
    return errorResponse(503, 'not_configured', '服务端未配置 nonce 存储')
  }
  const blobToken = serverEnv('BLOB_READ_WRITE_TOKEN')
  if (!blobToken) {
    return errorResponse(503, 'not_configured', '服务端未配置内容存储')
  }

  // ── ① 形状 ────────────────────────────────────────────────────────────
  // 请求体是客户端完全可控的。`request.json()` 对畸形 JSON 会**抛**,
  // 不包起来就是"发一段坏 JSON 换一个 500"。
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return errorResponse(400, 'bad_request', '请求体不是合法 JSON')
  }
  const wire = parseUnlockWire(raw)
  if (!wire) return errorResponse(400, 'bad_request', '请求体形状不对')

  const message = toUnlockMessage(wire)
  const { contentId, buyer, nonce, deadline } = message

  // ── ② 签名 ────────────────────────────────────────────────────────────
  // 这是**唯一**能证明"调用者就是 buyer"的东西 —— 其它字段(包括 contentId)
  // 都在签名覆盖范围内,所以它们不需要单独再验一遍:签名过了就等于它们
  // 都是签名者认可过的值。
  //
  // ⚠️ 用 `SPLITTER_ADDRESS`(服务端 env 优先)而不是默认的
  // `DEPLOYED_SPLITTER`,理由与 `server/chain.ts` 同:换了合约时两端
  // 必须同时换,而这里读的是**服务端**那一侧的值。前端签名时读的是
  // `VITE_SPLITTER_ADDRESS`,两者缺省都回落同一个常量。
  let recovered: Address
  try {
    recovered = await recoverTypedDataAddress({
      ...unlockTypedData(message, SPLITTER_ADDRESS),
      signature: wire.signature as Hex,
    })
  } catch {
    // 形状已在 parseUnlockWire 卡过(长度 132 + 严格 hex),能抛到这里说明
    // 是密码学层面的事(`s` 值超出曲线阶、`v` 不是 27/28 等)。一样按验签失败处理。
    return errorResponse(401, 'bad_signature', '签名无法解析')
  }
  // ⚠️ **断言"恢复出的地址 == 签名里的 buyer"**,而不是拿恢复出的地址去查链。
  // 两者结果一样,但这条断言在 buyer 字段被篡改时**当场失败** —— 而
  // "直接拿恢复值查链"会把那次篡改悄悄吞掉,表现为"查了另一个人的付款记录"。
  // (方案 §9.2 已定;buyer 显式入签的可读性理由见 shared/unlock.ts)
  if (recovered.toLowerCase() !== buyer.toLowerCase()) {
    return errorResponse(401, 'bad_signature', '签名与买家地址不符')
  }

  // ── ③ 时效 ────────────────────────────────────────────────────────────
  // 单位是**秒**。`Date.now()` 是毫秒,这里显式除。
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  if (deadline <= nowSeconds) {
    return errorResponse(401, 'deadline_expired', '签名已过期')
  }

  // ── ④ nonce ───────────────────────────────────────────────────────────
  // ⚠️ `peekNonce` 只读不删 —— 删除是第 ⑥ 步的事,见文件头。
  let boundContentId: string | null
  try {
    boundContentId = await peekNonce(nonce.toString())
  } catch {
    return errorResponse(503, 'upstream_unavailable', 'nonce 服务暂时不可用')
  }
  if (boundContentId === null) {
    // 四种情况在这里是**不可区分**的:没发过 / 已过期 / 已用掉 / KV 没配。
    // 调用方也不需要区分 —— 正确的反应都是"重新取一次 nonce 再签"。
    return errorResponse(401, 'nonce_expired', 'nonce 无效或已用过')
  }
  if (boundContentId !== contentId) {
    // 一个为 A 内容签发的 nonce 被拿来解锁 B。见 server/kv.ts 的 `nonceKey`。
    return errorResponse(401, 'nonce_mismatch', 'nonce 与内容不匹配')
  }

  // ── ⑤ 付款 ────────────────────────────────────────────────────────────
  let paid: boolean
  try {
    paid = await hasPurchased(contentId, buyer)
  } catch {
    // ⚠️ 这里**绝不能**写成 `paid = false`。RPC 读不到 ≠ 没买。
    return errorResponse(503, 'upstream_unavailable', '链上查询暂时不可用')
  }
  if (!paid) {
    return errorResponse(402, 'not_purchased', '尚未购买这份内容')
  }

  // ── ⑥ 签发短时效 URL,然后立刻用掉 nonce ──────────────────────────────
  //
  // 这里调的是 Blob 的**控制面**:`issueSignedToken` 向 Blob 换一份
  // "只允许 get、只针对这一条 pathname、60 秒后作废"的委派凭证,
  // `presignUrl` 再拿它算出一条可直接 GET 的 URL。
  //
  // ⚠️ **绝不能**图省事直接把 `BLOB_READ_WRITE_TOKEN` 发给前端 ——
  // 那是 store 级的读写凭证,等于把整个私有 store 交出去。这正是
  // 方案 §9.1 要求"写入凭证不进前端"的同一件事,只是换成了读侧。
  //
  // ⚠️ 用 `contentPathname()` **重算**路径,不接受客户端给的任何路径片段。
  const pathname = contentPathname(contentId)
  const validUntil = Date.now() + UNLOCK_URL_TTL_SECONDS * 1000

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
      // 绕开 CDN 缓存直读源站。这一条不影响正确性(内容写入后不可覆盖),
      // 但让"刚传完就能下"这件事在演示里不依赖缓存过期。
      useCache: false,
    })

    // ⚠️ 必须再过一遍 `getDownloadUrl`,不能直接返回 `presignedUrl`。
    //
    // 它只是往 query 里塞一个 `download=1`(就一行 `searchParams.set`,
    // 不额外发请求),让响应带上 `Content-Disposition: attachment`。
    // **少了它,浏览器不会下载,会直接打开** —— 2026-09-23 实测:点了下载
    // 出来一个内联页面,得手动"另存为"。
    //
    // 根因是这条链路**永远跨源**:app 在 `splitjar.vercel.app`,blob 在
    // `*.private.blob.vercel-storage.com`。而前端那个 `<a download>` 属性
    // 对跨源 URL 是**被规范明确忽略**的(只在同源 / `blob:` / `data:` 下生效),
    // 所以"让它下载"这件事**只能由服务端定**,前端再怎么写都没用。
    //
    // 安全性:`download` **不在** SDK 的 `PRESIGN_CANONICAL_QUERY_KEYS` 里
    // (那一组只有 put 相关的 addRandomSuffix / allowOverwrite / maximumSize /
    // validUntil 等),所以加它**不会**让签名失效 —— 与 `cache` 同理。
    //
    // 完整来龙去脉(含"为什么不能靠 presign 传 contentDisposition")见方案 §20.4.5.1。
    url = getDownloadUrl(presignedUrl)
  } catch {
    return errorResponse(503, 'upstream_unavailable', '内容存储暂时不可用')
  }

  // ⚠️ 最后一步。`false` 表示 nonce 在我们做完上面所有事的这段时间里
  // 被另一个并发请求删掉了 —— 那是一次重放,必须拒。
  // 此时链接已经签发出来了,但我们**不返回它**;它 60 秒后自然作废。
  let consumed: boolean
  try {
    consumed = await consumeNonce(nonce.toString())
  } catch {
    return errorResponse(503, 'upstream_unavailable', 'nonce 服务暂时不可用')
  }
  if (!consumed) {
    return errorResponse(409, 'nonce_expired', '这个 nonce 已经被用过了')
  }

  return Response.json({
    url,
    expiresInSeconds: UNLOCK_URL_TTL_SECONDS,
  } satisfies UnlockResponse)
}
