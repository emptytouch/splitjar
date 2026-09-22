import { isContentId } from '../shared/storage.js'
import type { UnlockNonceResponse } from '../shared/unlock.js'
import { NONCE_TTL_SECONDS } from '../shared/unlock.js'
import { errorResponse } from '../shared/api.js'
import { issueNonce, kvConfigured } from '../server/kv.js'

/**
 * `GET /api/unlock-nonce?contentId=0x…` —— 签发一个一次性 nonce。
 *
 * ## 它在防什么(方案 §9.2)
 *
 * 门禁那条签名**没有链上 nonce**,如果就这样收下,一张签好的授权
 * 就能被无限次重放 —— 谁截到都能一直换下载链接。所以签名里放一个
 * 服务端签发的一次性值,KV 里存着,**用掉即删**。
 *
 * ⚠️ **nonce 不是"防伪造",而是"防重放"。** 攻击者拿到 nonce 也没用,
 * 他签不出买家的名。所以它是公开可取的 —— 不需要鉴权,也不需要保密。
 * 这一点值得写清楚,免得后人以为这里少了什么检查。
 *
 * ## 为什么 nonce 的值绑定了 contentId
 *
 * `issueNonce` 把 nonce 的值写成"它是给哪个 contentId 签发的"。
 * 这样 `POST /api/unlock` 能顺带确认"这个 nonce 确实是给这份内容发的",
 * 而不是一张万能通行证 —— 一个为 A 内容签发的 nonce 拿去解锁 B 会被拒。
 *
 * ## 为什么先发 nonce 再去链上查"买没买"
 *
 * 顺序是**刻意的**:发 nonce 时不碰链。这样"没买的人"也能拿到 nonce、
 * 也能签出合法签名,然后才在 `/api/unlock` 被链上数据拒掉。
 * 反过来做(先查链再发 nonce)会让"你没买"这个信息提前泄露给未购买者,
 * 而它本来只该在真正尝试解锁时才知道。
 */
/**
 * ⚠️ **具名 `GET`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 *
 * 这个端点是 GET(只收 query 里的 contentId,不改任何状态);
 * 发 nonce 虽然写 KV,但它是"取一个凭证",语义上仍是读。
 */
export async function GET(request: Request): Promise<Response> {
  if (!kvConfigured()) {
    return errorResponse(503, 'not_configured', '服务端未配置 nonce 存储')
  }

  const contentId = new URL(request.url).searchParams.get('contentId')
  // 形状不对就直接拒 —— 注意这里用 `isContentId`(只收小写)而不是
  // `isBytes32`(大小写都收):nonce 要跟 `POST /api/unlock` 里的
  // contentId 做字符串比对,大小写不统一会让同一份内容看起来像两份。
  if (!isContentId(contentId)) {
    return errorResponse(400, 'bad_request', 'contentId 形状不对')
  }

  try {
    const nonce = await issueNonce(contentId)
    return Response.json({
      nonce,
      expiresInSeconds: NONCE_TTL_SECONDS,
    } satisfies UnlockNonceResponse)
  } catch {
    // `issueNonce` 只有"成功"和"抛"两种结果(见 server/kv.ts),走到这里
    // 说明 Redis 写不进去。**不能**降级成"发一个假 nonce" ——
    // 那会让门禁变成可重放,正是这个接口要防的事。
    return errorResponse(503, 'upstream_unavailable', 'nonce 服务暂时不可用')
  }
}
