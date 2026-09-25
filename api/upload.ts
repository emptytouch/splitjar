// ⚠️ `handleUpload` 在 **`@vercel/blob/client`** 这个子路径下,**不在** `@vercel/blob`。
// 主入口只导出 put/upload/issueSignedToken/presignUrl 那一组。"client" 在这里指
// "客户端直传"这套流程,不是"在浏览器里跑" —— `handleUpload` 恰恰是服务端用的那一半。
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { recoverTypedDataAddress, type Address, type Hex } from 'viem'
import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  UPLOAD_TOKEN_TTL_MS,
  parseUploadPathname,
  uploadPathname,
  type UploadTarget,
} from '../shared/storage.js'
import {
  allowsUploadTarget,
  decodeUploadClientPayload,
  parseUploadAuth,
  toUploadMessage,
  uploadTypedData,
} from '../shared/upload.js'
import { getContentCreator, SPLITTER_ADDRESS } from '../server/chain.js'
import { serverEnv } from '../server/env.js'
import { errorResponse, type ApiErrorCode } from '../shared/api.js'
import { claimUploader, getUploader, kvConfigured } from '../server/kv.js'

/**
 * `POST /api/upload` —— 签发**受限的上传 token**(方案 §9.1 / 开发计划 §八 W5-R8)。
 *
 * ## 为什么文件不经过这个 Function
 *
 * **Function 的请求体上限是 4.5 MB**,而内容文件没有尺寸约束。
 * 所以走的是客户端直传:这个路由只负责"发一张门票",文件本身由浏览器
 * 直接 PUT 到 Blob。(方案 §9.1 已记这条边界)
 *
 * ## ⚠️ W5-R8:两个 store,两种凭证,而 `handleUpload` 只收一个 `token`
 *
 * `handleUpload({ token, … })` 的 `token` 是**整个调用**共用的,可是
 * 内容落私有 store(`BLOB_READ_WRITE_TOKEN`)、预览图落公开 store
 * (`PUBLIC__READ_WRITE_TOKEN`)—— 一个 `token` 参数装不下两种。
 *
 * 解法是**先自己把请求体读出来**,从 pathname 前缀判出这次要往哪个 store 落,
 * 再选对应的凭证传进去。这样 `storeId` 从头到尾**一次都没出现过** ——
 * 正是 W5-R8 要求的那种写法(用显式 `token`,永不设 `storeId`)。
 *
 * 顺序上这是安全的:这里的判断只决定"用哪张凭证去换门票",
 * **真正的授权**是下面 `onBeforeGenerateToken` 里那一整套校验。
 *
 * ## ⚠️ `onBeforeGenerateToken` 拿不到 pathname 的选择权
 *
 * `@vercel/blob` 2.8.0 的 `onBeforeGenerateToken(pathname, clientPayload, multipart)`
 * 返回值是 `Pick<GenerateClientTokenOptions, …>`,**其中不含 `pathname`** ——
 * 也就是说**要传到哪里是客户端说了算的**。所以服务端必须自己
 * **用 `contentId` 重算一遍期望路径,再和客户端交上来的做逐字节比较**
 * (见下面 `uploadPathname`)。所有校验都建立在这个重算值上。
 */
/**
 * ⚠️ **具名 `POST`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 */
export async function POST(request: Request): Promise<Response> {
  // 请求体是客户端可控的,畸形 JSON 会让 `request.json()` 抛 → 必须包起来
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, 'bad_request', '请求体不是合法 JSON')
  }

  /**
   * ── 预检分支 ────────────────────────────────────────────────────────
   *
   * 靠**形状**分流,不靠 URL 参数:SDK 发来的 `HandleUploadBody` 一定带
   * `type` 字段,我们自己的 `UploadAuthWire` 一定不带(它只有
   * contentId/targets/uploader/deadline/signature 五个)。两者在结构上
   * 不可能混淆 —— 这比"加个 query 参数区分"安全,因为**参数是客户端说了算的**,
   * 而形状判错了只会走进另一条也无害的分支。
   *
   * 客户端在调 `upload()` 之前先打这一枪,拿的是**服务端真实的拒绝理由**
   * (那段 SDK 丢响应体的来龙去脉见下面 `verifyUploadAuth` 的注释)。
   */
  if (typeof body !== 'object' || body === null || !('type' in body)) {
    return await preflight(body)
  }

  const uploadBody = body as HandleUploadBody

  // 我们**从不**设置 `callbackUrl`(确定性 pathname 让回调失去意义,
  // 而回调需要一个公网可达地址 —— 那正是当初放弃随机后缀的原因,
  // 见 shared/storage.ts)。所以这里只该出现"要门票"这一种事件;
  // 收到"上传完成"事件说明有人自己构造了一个,直接拒。
  if (uploadBody.type !== 'blob.generate-client-token') {
    return errorResponse(400, 'bad_request', '不支持的事件类型')
  }

  // 先按 pathname 判该用哪个 store 的凭证 —— 见文件头 W5-R8 那段
  const claimed = parseUploadPathname(uploadBody.payload.pathname)
  if (!claimed) {
    return errorResponse(400, 'bad_request', 'pathname 形状不对')
  }
  const blobToken = tokenFor(claimed.target)
  if (!blobToken) {
    return errorResponse(503, 'not_configured', '服务端未配置上传存储')
  }

  try {
    const result = await handleUpload({
      token: blobToken,
      request,
      body: uploadBody,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const auth = await authorizeUpload(pathname, clientPayload)
        return {
          // 内容**不限类型**(创作者传什么都有可能,见 shared/storage.ts);
          // 预览图只收图片。`undefined` 在 SDK 里表示"不加限制"。
          allowedContentTypes: ALLOWED_CONTENT_TYPES[auth.target],
          maximumSizeInBytes: MAX_UPLOAD_BYTES[auth.target],
          // ⚠️ `allowOverwrite` 必须显式为 `false`。SDK 的默认值就是 false,
          // 但这条**是"同一个 contentId 只能写一次"的唯一保证**(pathname 是
          // 确定性的、不含随机后缀),默认值哪天变了不该让安全性跟着变。
          allowOverwrite: false,
          // 同理,显式关掉。pathname 由服务端算好,掺随机后缀会让
          // 客户端与服务端对"传到了哪里"产生分歧。
          addRandomSuffix: false,
          // 绝对时刻(ms since epoch),不是相对秒数
          validUntil: Date.now() + UPLOAD_TOKEN_TTL_MS,
        }
      },
    })
    return Response.json(result)
  } catch (error) {
    if (error instanceof UploadRejection) {
      // ⚠️ 记一条服务端日志。`@vercel/blob` 的客户端 SDK 在拿到非 2xx 时
      // **不读响应体**,只会抛一句笼统的 "Failed to retrieve the client token"
      // (已核实 client.js)。所以这里拒掉的原因**只有日志留得下** ——
      // 不给前端留一份,演示现场就只能靠猜。
      console.error('[api/upload] 拒绝:', error.code, error.detail ?? '')
      return errorResponse(error.status, error.code, error.message)
    }
    console.error('[api/upload] 上游失败:', error)
    return errorResponse(503, 'upstream_unavailable', '上传服务暂时不可用')
  }
}

/**
 * 预检 —— 只回答一个问题:**这次上传有没有"重试也修不好"的毛病**。
 *
 * 它跑的是 ①–④,外加两个**纯环境检查**(上传凭证、KV 凭证)。不读链、不认领 KV。
 *
 * ## 为什么两个环境检查必须在这里,哪怕它们分别属于"签发门票"和 ⑥
 *
 * 因为**这两条恰恰是最会骗人的**。凭证没配或 KV 没配时,真正的上传会以
 * 那句笼统的 SDK 错误告终,界面于是显示"网络或存储暂时出问题了,重试即可"
 * —— 而重试一万次也不会好。演示当天最可能踩的就是这个坑
 * (KV 在本机根本连不上,只能部署后在 Vercel 上验,所以配漏了也不奇怪)。
 *
 * 反过来说,⑤ 链上归属**故意不在这里查**:它是一次真 RPC,失败多半是节点抖动,
 * 而"重试"对那种情况本来就是对的答案。
 */
async function preflight(body: unknown): Promise<Response> {
  const auth = parseUploadAuth(body)
  if (!auth) {
    return errorResponse(400, 'bad_request', '上传授权形状不对')
  }

  // 与真正签发门票那一步**同一个判断**(见 `POST` 里的 `tokenFor`)。
  // 两处用同一个函数,不会出现"预检说没问题、真传的时候说没配"
  //
  // ⚠️ 2026-09-25:一条授权可以覆盖**多个** store,所以逐个查。
  // 少配一个,那一段上传就必然以那句笼统的 SDK 错误告终 ——
  // 而"把这种重试没用的错如实说出来"正是预检存在的全部理由。
  for (const target of auth.targets) {
    if (!tokenFor(target)) {
      return errorResponse(503, 'not_configured', '服务端未配置上传存储')
    }
  }
  // 纯环境检查,不发请求 —— 但它对应的 ⑥ 是预检唯一覆盖不到的拒绝原因,
  // 而它又是最可能真实发生的那一个
  if (!kvConfigured()) {
    return errorResponse(503, 'not_configured', '服务端未配置上传归属存储')
  }

  // 用**服务端重算**的 pathname,与真实上传走的是同一条路径。
  // 预检要是用了别的路径,它验过的和真正会发生的就成了两回事
  const pathnames: string[] = []
  try {
    for (const target of auth.targets) {
      pathnames.push(uploadPathname(target, auth.contentId as Hex))
    }
  } catch {
    // `parseUploadAuth` 的 `isBytes32` 收大小写,而 `uploadPathname` 只收小写
    // (理由见 shared/storage.ts:大小写会让同一个 contentId 对应多个 pathname)
    return errorResponse(400, 'bad_request', 'contentId 必须是小写十六进制')
  }

  try {
    // ⚠️ **每条路径都要过一遍验签**,不能只验第一条:签名覆盖的是整个
    // `targets` 数组,一条授权对某几个 store 有效、对别的无效是可能的,
    // 而那半边的问题必须在这里暴露,而不是等真传时才炸
    for (const pathname of pathnames) {
      await verifyUploadAuth(pathname, JSON.stringify(auth))
    }
    return Response.json({ ok: true, pathnames })
  } catch (error) {
    if (error instanceof UploadRejection) {
      return errorResponse(error.status, error.code, error.message)
    }
    console.error('[api/upload] 预检异常:', error)
    return errorResponse(503, 'upstream_unavailable', '签名校验暂时不可用')
  }
}

/**
 * 按目标挑凭证。
 *
 * ⚠️ **两个变量名都不是随手起的**:私有 store 是 Vercel 自动注入的固定名,
 * 公开 store 那份是撞名之后手工加的 —— 名字的来历与"别改"的理由写在
 * `server/env.ts` 里,改动前先读那段。
 */
function tokenFor(target: UploadTarget): string | undefined {
  return target === 'content'
    ? serverEnv('BLOB_READ_WRITE_TOKEN')
    : serverEnv('PUBLIC__READ_WRITE_TOKEN')
}

/** 被我们主动拒掉的上传 —— 与"上游炸了"必须分开,前者是我们判的,后者不是 */
class UploadRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}

/**
 * 上传授权的全部校验 —— 返回**重算出来的** target(调用方据此取类型/体积上限)。
 *
 * 六道检查:
 *
 * ```
 * ① clientPayload 形状      decodeUploadClientPayload      畸形 → 400
 * ② 路径一致性              重算 pathname 逐字节相等       不一致 → 400
 * ③ 签名                    recover == uploader            伪造 → 401
 * ④ 时效                    deadline > now                过期 → 401
 * ⑤ 链上归属                已注册内容的创建者必须是本人     别人的 → 403
 * ⑥ KV 归属                 先到先得,之后只认同一个地址     别人的 → 403
 * ```
 *
 * ## ② 为什么是"重算再比",而不是"解析后用解析值"
 *
 * 解析值只能说明"这条 pathname 声称自己是什么"。如果直接拿它去签发 token,
 * 那就等于**用客户端的输入决定往哪写** —— 一个形如 `content/0x…` 的路径
 * 会拿到私有 store 的写入权。重算的意义在于:期望值只由 `contentId` 与
 * `target` 决定,两者都在签名覆盖范围内(见 shared/upload.ts),所以
 * 攻击者改任何一处都会让 ② 或 ③ 至少一处失败。
 *
 * ## ⑤ 与 ⑥ 是**两层**归属,不是重复
 *
 * ⑤ 读链,是**持久且公开可验证**的归属;⑥ 读 KV,是链上还没有记录时的
 * 先到先得。只有 ⑥ 的话,KV 被清空就等于归属被清空;只有 ⑤ 的话,
 * 未注册的内容(nonce 阶段还没上链)就没法防抢注。
 */
async function authorizeUpload(
  pathname: string,
  clientPayload: string | null,
): Promise<{ target: UploadTarget }> {
  const { contentId, uploader, target } = await verifyUploadAuth(pathname, clientPayload)

  // ── ⑤ 链上归属 ────────────────────────────────────────────────────────
  // 内容已经注册过 → 只有合约认定的创作者本人能往上写。
  let creator: Address | null
  try {
    creator = await getContentCreator(contentId)
  } catch {
    // 读不到 ≠ 没注册。这里必须拒,不能放行(见 server/chain.ts 的拦释)
    throw new UploadRejection(503, 'upstream_unavailable', '链上查询暂时不可用')
  }
  if (creator !== null && creator.toLowerCase() !== uploader.toLowerCase()) {
    throw new UploadRejection(403, 'content_claimed', '这份内容属于另一个地址', creator)
  }

  // ── ⑥ KV 归属 ─────────────────────────────────────────────────────────
  if (!kvConfigured()) {
    throw new UploadRejection(503, 'not_configured', '服务端未配置上传归属存储')
  }
  let claimedNow: boolean
  try {
    claimedNow = await claimUploader(contentId, uploader)
  } catch (e) {
    // ⚠️ 把真实原因记下来。这两条 503 的**对外文案是一样的**(不能给探针
    // 更多信息),所以不给日志的话,"KV 挂了"和"代码写错了"在现场看起来
    // 一模一样 —— 而这个文件自己在上面已经立过规矩:只有日志留得下。
    console.error('[api/upload] 认领上传归属失败:', e)
    throw new UploadRejection(503, 'upstream_unavailable', '上传归属服务暂时不可用')
  }
  if (!claimedNow) {
    // 已经有主了。**同一地址重复上传是允许的** —— 传失败要能重来,
    // 而真正的"同一个 contentId 只能写一次"由平台侧的 `allowOverwrite: false`
    // 保证(blob 已存在时会被平台直接拒),不需要在这里再拦一道。
    let owner: string | null
    try {
      owner = await getUploader(contentId)
    } catch (e) {
      console.error('[api/upload] 读上传归属失败:', e)
      throw new UploadRejection(503, 'upstream_unavailable', '上传归属服务暂时不可用')
    }
    // 比对一律**先小写** —— 存进去的是 checksum 形态,但大小写不同的
    // 同一个地址必须算同一个人。这条纪律与 `parseUploadAuth` 里的地址
    // 归一化是同一件事的两端。
    if (owner === null || owner.toLowerCase() !== uploader.toLowerCase()) {
      throw new UploadRejection(403, 'content_claimed', '这份内容已被另一个地址认领', owner ?? '')
    }
  }

  return { target }
}

/**
 * ①–④ —— **廉价的那一半**:形状、路径、签名、时效。
 *
 * 刻意拆出来,因为这一半**不碰链、不碰 KV**,只做一次 ecrecover。
 * 于是它可以被单独拿去做**预检**(见 `POST` 里的预检分支)。
 *
 * ## 为什么需要预检(2026-09-23)
 *
 * `@vercel/blob` 的客户端 SDK 拿到非 2xx 时**不读响应体**,只抛一句笼统的
 * `BlobError('Failed to retrieve the client token')`(**无状态码、无 code**,
 * 已核实 `dist/client.js`)。后果是**服务端精心分的那些 code 一个都到不了前端**,
 * 于是"服务端没配 KV"这种**重试一万次也不会好**的错误,会被界面显示成
 * "网络或存储暂时出问题了,重试即可" —— 一句会骗人的话。
 *
 * 所以浏览器在调 `upload()` **之前**先打一次预检,把这一半的错误如实拿到手。
 *
 * ⚠️ 预检**不覆盖** ⑤⑥(链上归属、KV 归属),这是有意的:
 * 那两步要读链、要写 KV,重复一遍纯属浪费;而且它们失败时给"重试"
 * 是对的(链上节点抖动、KV 抖动,重试确实可能好)。
 * 换句话说:**预检只负责把"重试没用的"那几条挑出来如实说。**
 */
async function verifyUploadAuth(
  pathname: string,
  clientPayload: string | null,
): Promise<{ contentId: Hex; uploader: Address; target: UploadTarget }> {
  // ── ① clientPayload 形状 ──────────────────────────────────────────────
  // ⚠️ 这个字符串**完全由客户端控制**,只是"顺带捎过来"的搬运通道,
  // 不是信任边界(见 shared/upload.ts 的 `encodeUploadClientPayload`)。
  const auth = decodeUploadClientPayload(clientPayload)
  if (!auth) {
    throw new UploadRejection(400, 'bad_request', '上传授权形状不对')
  }

  // ── ② 路径一致性 ──────────────────────────────────────────────────────
  const parsed = parseUploadPathname(pathname)
  if (!parsed) {
    throw new UploadRejection(400, 'bad_request', 'pathname 形状不对')
  }
  // 用**服务端重算**的期望路径来比。`uploadPathname` 对这个 contentId
  // 只会产出小写形式,所以 `content/0xABC…` 这种会在这里被拒 ——
  // 那正是 `CONTENT_ID_RE` 只收小写要防的事(见 shared/storage.ts)。
  const expected = uploadPathname(parsed.target, parsed.contentId)
  if (pathname !== expected) {
    throw new UploadRejection(400, 'bad_request', 'pathname 与授权不符', pathname)
  }
  // 签名里**必须列了这个** target —— 否则一条"传预览图"的授权
  // 就能被拿去写 `content/`(那会把付费内容写进公开 store)。
  if (!allowsUploadTarget(auth, parsed.target)) {
    throw new UploadRejection(400, 'bad_request', 'target 不在授权范围内', parsed.target)
  }

  const message = toUploadMessage(auth)

  // ── ③ 签名 ────────────────────────────────────────────────────────────
  let recovered: Address
  try {
    recovered = await recoverTypedDataAddress({
      ...uploadTypedData(message, SPLITTER_ADDRESS),
      signature: auth.signature as Hex,
    })
  } catch {
    throw new UploadRejection(401, 'bad_signature', '签名无法解析')
  }
  // 与 `api/unlock.ts` 同一条纪律:断言"恢复出的地址 == 签名里的 uploader",
  // 而不是直接拿恢复值往下用。
  if (recovered.toLowerCase() !== message.uploader.toLowerCase()) {
    throw new UploadRejection(401, 'bad_signature', '签名与上传者地址不符')
  }

  // ── ④ 时效 ────────────────────────────────────────────────────────────
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  if (message.deadline <= nowSeconds) {
    throw new UploadRejection(401, 'deadline_expired', '签名已过期')
  }

  return { contentId: message.contentId, uploader: message.uploader, target: parsed.target }
}
