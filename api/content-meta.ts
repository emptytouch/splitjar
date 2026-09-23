import { recoverTypedDataAddress, type Address, type Hex } from 'viem'
import { errorResponse } from '../shared/api.js'
import { normalizeTitle } from '../shared/contentMeta.js'
import { isContentId } from '../shared/storage.js'
import { parseUploadAuth, toUploadMessage, uploadTypedData } from '../shared/upload.js'
import { getContentCreator, SPLITTER_ADDRESS } from '../server/chain.js'
import { kvConfigured, setContentTitle } from '../server/kv.js'

/**
 * `POST /api/content-meta` —— 创作者把**标题**写进 KV(方案 §9.4 的 catalog 要返回它)。
 *
 * ## 为什么需要这个端点:链上根本没有标题
 *
 * 合约的 `Content` struct 只有 `creator / price / contentHash / recipients /
 * splits / active`,**没有标题字段**,`ContentRegistered` 事件里也没有。
 * 而方案 §9.4 的 `GET /api/catalog` 明确要返回 `title`。
 *
 * 在此之前标题**只存在于创作者自己浏览器的 localStorage**
 * (`src/lib/contentMeta.ts`,key `splitjar.content.v1`)—— 服务端零来源。
 * 方案 §10 描述的正解就是写 KV("顺手把易读记录写进 KV"),这里把它做了。
 *
 * ## ⚠️ 复用 `Upload` 那条 EIP-712 签名,**不新造一种**
 *
 * 判据是"避免多一种会让签名永远验不过的东西":EIP-712 里只要 domain 或类型
 * 定义有一处对不上,症状就是**签名静默失效**,而报错看不出哪里错了
 * (见 `shared/eip712.ts` 文件头)。`Upload` 那条已经在跑、已经被验过,
 * 复用它是零新增密码学。
 *
 * 代价是请求体里必须带一个对本接口毫无意义的 `target`。**服务端把它钉死成
 * `'content'`**:虽然今天 `'content'` 与 `'preview'` 在这条路上授予的是同一件事
 * (都是"创作者本人要求改自己内容的标题"),但"一条签名只够干一件事"是
 * `shared/upload.ts` 立下的规矩,这里不开口子。
 *
 * ## ⚠️ 没有 nonce,理由与 upload 那条**不完全一样**(如实说明)
 *
 * `Upload` 签名刻意不带 nonce(见 `shared/upload.ts`:重放它只能拿到一张指向
 * **已存在 blob** 的 token,平台侧 `allowOverwrite: false` 会直接拒,所以重放
 * 没有后果)。这条端点的情况是:**重放它只能把标题改成同一个创作者自己写过的
 * 同一个值** —— 因为归属检查会挡住别人。所以同样无后果。
 * 只靠 `deadline` 兜底。
 *
 * ## ⚠️ 已有内容需要回填
 *
 * 演示内容 `0x6410fb…ef986f` 建于这个端点存在**之前**,它的标题只在本机
 * localStorage 里。`GET /api/catalog` 对它返回的 `title` 会是 `null` ——
 * **那是正常状态,不是 bug**。要么重新创建一件,要么调一次本端点补上。
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

  // `title` 与签名那几个字段是**分开**校验的:`parseUploadAuth` 只认
  // contentId/target/uploader/deadline/signature 五个字符串字段,
  // 多出来的 `title` 它不碰(见 shared/eip712.ts 的 `parseStringFields`)。
  // 所以标题要从原始 body 里单独取。
  const rawTitle = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).title : undefined
  if (typeof rawTitle !== 'string') {
    return errorResponse(400, 'bad_request', '缺少标题')
  }
  const title = normalizeTitle(rawTitle)
  // ⚠️ 空标题**拒掉**,不写空串。`normalizeTitle` 会把全空白变成 `""`,
  // 而 catalog 用 `null` 表示"没有标题" —— 两者必须能分开,否则
  // "标题被写成空白"和"从没设过标题"在响应里长得一模一样
  if (!title) {
    return errorResponse(400, 'bad_request', '标题不能为空')
  }

  const auth = parseUploadAuth(body)
  if (!auth) {
    return errorResponse(400, 'bad_request', '授权形状不对')
  }
  // 见文件头:复用 `Upload` 但把用途钉死
  if (auth.target !== 'content') {
    return errorResponse(400, 'bad_request', '这条授权不是用于内容本身的')
  }
  const contentId = auth.contentId as Hex
  if (!isContentId(contentId)) {
    // `parseUploadAuth` 里的 `isBytes32` 收大小写,而下游 KV 键、
    // 链上查询与 `contentPathname` 都按小写走(见 shared/storage.ts)
    return errorResponse(400, 'bad_request', 'contentId 必须是小写十六进制')
  }

  const message = toUploadMessage(auth)

  // ── 依赖检查 ──────────────────────────────────────────────────────────
  // ⚠️ **排在上面那几道形状检查之后**(2026-09-23 定的,与 `/api/content/:id` 同一条)。
  // 形状检查是**纯函数** —— 不碰网络、不碰密钥、读不到 KV 也照样能判。
  // 先做它们永远不会有更差的答案,而且能立刻告诉调用方"错在你的请求里"。
  //
  // 反过来写(依赖在前)的症状:KV 一抖,一个坏 JSON 会得到"服务端没配存储"
  // 这种与请求毫无关系的说法。
  //
  // ⚠️ 但它**必须早于下面的验签和读链**:那两步是真实开销(一次 ECDSA 恢复
  // + 一次 `eth_call`),不能白做。
  if (!kvConfigured()) {
    return errorResponse(503, 'not_configured', '服务端未配置内容元信息存储')
  }

  // ── 验签 ──────────────────────────────────────────────────────────────
  let recovered: Address
  try {
    recovered = await recoverTypedDataAddress({
      ...uploadTypedData(message, SPLITTER_ADDRESS),
      signature: auth.signature as Hex,
    })
  } catch {
    return errorResponse(401, 'bad_signature', '签名无法解析')
  }
  // 与 `api/unlock.ts` / `api/upload.ts` 同一条纪律:断言"恢复出的地址 ==
  // 签名里的 uploader",而不是直接拿恢复值往下用 —— 后者会在 uploader
  // 字段被篡改时**静默地**按另一个人的身份继续
  if (recovered.toLowerCase() !== auth.uploader.toLowerCase()) {
    return errorResponse(401, 'bad_signature', '签名与上传者地址不符')
  }

  // ── 时效 ──────────────────────────────────────────────────────────────
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  if (message.deadline <= nowSeconds) {
    return errorResponse(401, 'deadline_expired', '签名已过期')
  }

  // ── 链上归属:只有创作者能改自己内容的标题 ──────────────────────────
  let creator: Address | null
  try {
    creator = await getContentCreator(contentId)
  } catch {
    // 读不到 ≠ 不存在。见 server/chain.ts 的拦截说明
    return errorResponse(503, 'upstream_unavailable', '链上查询暂时不可用')
  }
  if (creator === null) {
    return errorResponse(404, 'content_not_found', '这份内容还没上链,无法设置标题')
  }
  if (creator.toLowerCase() !== auth.uploader.toLowerCase()) {
    return errorResponse(403, 'content_claimed', '这份内容属于另一个地址')
  }

  // ── 写 KV ─────────────────────────────────────────────────────────────
  // ⚠️ 标题在这里**已经过 `normalizeTitle`**(长度上限 + 去首尾空白)。
  // 服务端不能信客户端传上来的长度:这个标题会被**所有 agent 的 catalog
  // 响应**读到,不截断就等于开了一个往别人响应里灌数据的位置。
  try {
    await setContentTitle(contentId, title)
  } catch {
    return errorResponse(503, 'upstream_unavailable', '内容元信息服务暂时不可用')
  }

  return Response.json({ ok: true, contentId, title })
}

/**
 * ⚠️ **只提供 POST,不提供 GET。**
 *
 * 读标题的正当入口是 `GET /api/catalog`(已经是批量、一次 `mget`)。
 * 单开一个 `GET /api/content-meta?contentId=…` 会多一条要维护、
 * 要鉴权、要限流的路 —— 而它没有任何调用方。
 * 需要单条标题时,`getContentTitle` 在服务端直接可用。
 */
export function GET(): Response {
  return errorResponse(405, 'bad_request', '这个端点只接受 POST')
}
