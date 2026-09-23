import { upload } from '@vercel/blob/client'
import { keccak256, type Address, type Hex } from 'viem'
import type { ApiError, ApiErrorCode } from '../../shared/api'
import type { UploadTarget } from '../../shared/storage'
import {
  UPLOAD_TYPES,
  encodeUploadClientPayload,
  fromUploadMessage,
  nextUploadDeadline,
  uploadTypedData,
  type UploadAuthWire,
  type UploadMessage,
} from '../../shared/upload'
import type { PublishFailReason } from './publishMachine'

/**
 * 发布流程里所有"离开浏览器"的动作 —— **上传这条链路上唯一碰网络的地方**。
 *
 * 与 `unlockApi.ts` 同一个写法、同一个理由:单独一个文件是为了让
 * "服务端返回什么 → 用户看到什么"这条映射**可读、可测**,
 * `usePublishFlow` 只管把它接到状态机上。
 *
 * ## 这里有三段等待,而它们的失败**性质完全不同**
 *
 * ```
 * 算哈希   纯本地。失败 = 我们自己的 bug
 * 签授权   钱包。失败 = 用户拒绝,或者钱包不支持
 * 传文件   网络。失败 = 重试可能有用
 * ```
 *
 * 所以下面把错误分成"有 `code` 的"(服务端明确告诉我们的)和"没有 `code` 的"
 * (网络、钱包、上游 SDK 抛的),两类都收敛成 `UploadError` —— 状态机只认这一种。
 */

/** 拿一个远端 URL 时用的路径,与 `uploadPathname` 必须一致(服务端会重算再比) */
export { uploadPathname } from '../../shared/storage'

export class UploadError extends Error {
  constructor(
    readonly reason: PublishFailReason,
    message: string,
    /** 服务端原始的 `code` / SDK 原始的报错,原样保留供显示 */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

/**
 * `ApiErrorCode` → `PublishFailReason`。
 *
 * ⚠️ 与 `unlockApi.ts` 的 `CODE_TO_REASON` 是**两张不同的表**,不要合并 ——
 * 同一个 code 在两条流程里的出路不一样。最明显的是 `content_claimed`:
 * 解锁时它意味着"我们发错了",发布时它意味着"这份内容已经被别人占了,
 * 得换一个再创建"。
 *
 * 写成 `Record<ApiErrorCode, …>` 而不是 `Partial<...>`,是为了让
 * **服务端新增一个 code 时这里编译报错** —— 否则新 code 会静默落到兜底分支,
 * 而"某个失败原因永远显示成网络繁忙"是最难发现的那种 bug。
 */
export const CODE_TO_REASON: Record<ApiErrorCode, PublishFailReason> = {
  // ── 指向我们自己 ─────────────────────────────────────────────
  bad_request: 'protocol',
  bad_signature: 'protocol',
  // ── 这份内容有主了。重试同一个 contentId 没有用 ──────────────
  content_claimed: 'claimed',
  // ── 过期。重试会签一张新的,所以是有用的 ─────────────────────
  deadline_expired: 'unavailable',
  // ── 上游 ───────────────────────────────────────────────────
  upstream_unavailable: 'unavailable',
  not_configured: 'unavailable',
  // ── 解锁专属的三个,发布流程里不该出现 ──────────────────────
  nonce_expired: 'protocol',
  nonce_mismatch: 'protocol',
  not_purchased: 'protocol',
  content_not_found: 'protocol',
  // ── W7 Agent 路径专属的六条,发布流程里**同样**不该出现 ──────
  // 发布走的是 `Upload` 签名(无 txHash、无报价、不看下架状态),
  // 这六条全是 agent 那条路的失败面。归 'protocol' 而不是 'unavailable':
  // 重试解决不了它们,别让界面提示用户"重试即可"。
  quote_invalid: 'protocol',
  quote_expired: 'protocol',
  payment_not_found: 'protocol',
  payment_mismatch: 'protocol',
  payment_replayed: 'protocol',
  content_inactive: 'protocol',
}

/**
 * 发一个带 JSON 体的请求,把非 2xx 翻译成 `UploadError`。
 *
 * ⚠️ 网络层失败(`fetch` 本身 reject)也走这里 —— 不处理的话它会以
 * `TypeError` 冒到状态机外面,而状态机只认 `UploadError`,
 * 结果是界面永远停在"正在准备…"。
 */
async function postJson(url: string, body: unknown): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    throw new UploadError('unavailable', '网络请求失败', e instanceof Error ? e.message : undefined)
  }

  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as ApiError | null
    const code = parsed?.error?.code
    if (code && code in CODE_TO_REASON) {
      throw new UploadError(CODE_TO_REASON[code], parsed?.error?.message ?? '请求被拒绝', code)
    }
    throw new UploadError('unavailable', '服务端返回了意外的响应', `HTTP ${res.status}`)
  }
}

/**
 * 算文件的 keccak256 —— 这个指纹会上链,买家下载完可以自己验一遍。
 *
 * 方案 §8.1 冻结的 `contentHash` 定义就是"内容文件的 keccak256"。
 * W4 一直传 `0x0` 是明确的"上传还没做"占位符,从这里开始它是真的了。
 *
 * ## ⚠️ 它把整个文件读进内存
 *
 * `file.arrayBuffer()` 会一次性载入,所以**峰值内存约等于文件大小**。
 * 200 MiB 的文件在手机上够呛。做成流式增量哈希需要一个增量 keccak 实现
 * (`@noble/hashes` 有,但它是 viem 的**传递依赖**,直接 import 它会在
 * lockfile 变化时悄悄断掉),所以这一版接受这个边界,如实记在方案 §20。
 * 演示素材的量级(几 MB 到几十 MB)完全没问题。
 */
export async function computeFileHash(file: File): Promise<Hex> {
  try {
    return keccak256(new Uint8Array(await file.arrayBuffer()))
  } catch (e) {
    // 读文件失败在正常浏览器里几乎不可能(文件被删/权限)。
    // 归到 `protocol` 是因为它**不是**网络问题,重试没有意义
    throw new UploadError('protocol', '读不出这个文件的内容', e instanceof Error ? e.message : undefined)
  }
}

/**
 * 预检 —— 在真正上传之前先问一次"这次上传有没有重试也修不好的毛病"。
 *
 * ## 为什么非要有这一步
 *
 * `@vercel/blob` 的客户端 SDK 拿到非 2xx 时**不读响应体**,只抛一句
 * `BlobError('Failed to retrieve the client token')` —— 没有状态码,也没有
 * `code`(已核实 `dist/client.js`)。后果是**服务端精心分的那些 code
 * 一个都到不了前端**,于是"服务端没配 KV"这种重试一万次也不会好的错误,
 * 会被显示成"网络问题,重试即可"。
 *
 * 所以先打这一枪。它只跑形状 / 签名 / 时效 / 配置四项,不读链、不认领 KV ——
 * 详见 `api/upload.ts` 里 `preflight` 的注释。
 *
 * ⚠️ 预检通过**不等于**上传会成功:预检和真传之间隔着一个来回,
 * 期间别人可能把这份内容认领走。所以它不是授权,只是"早点把坏消息说清楚"。
 */
export async function preflightUpload(wire: UploadAuthWire): Promise<void> {
  await postJson('/api/upload', wire)
}

/**
 * 把标题写进服务端 KV —— `GET /api/catalog` 的 `title` 就是从这里来的。
 *
 * ## 为什么复用**同一条** `Upload` 签名,而不是新签一条
 *
 * 判据是"这条签名管的是不是同一件事":`Upload` 已经钉死了 `target: 'content'`
 * (见 `shared/upload.ts`),而它的含义就是"**创作者本人对这份内容**的授权"。
 * 传文件是这件事,写标题也是这件事 —— 同一个 `contentId`、同一个 `uploader`。
 * 再弹一次钱包只为改一个标题,是拿一次真实的打扰换零新增的安全。
 *
 * ## ⚠️ 但它的 `deadline` 是**第 1 步**签的(5 分钟),所以可能已经过期
 *
 * 时序是 `签名 → 上传 → createContent 上链 → 回执`,标题只能写在第 4 步之后
 * (在那之前合约里还没有 `creator`,归属检查必回 404)。
 * 演示路径下(小文件 + Fuji 几秒出块)远不到 5 分钟,但**这个失败是可能的**。
 *
 * **所以调用方必须把它当尽力而为**:失败了就把标题留在 `null`,
 * catalog 会照常返回这件内容(见 `shared/agentPay.ts` 的 `CatalogEntry.title`)。
 * ⚠️ **绝不能**让它的失败把一个已经成功的创建说成失败 —— 内容已经上链、钱已经花了。
 */
export async function publishContentTitle(args: {
  contentId: Hex
  title: string
  /** 第 1 步签的那条 `Upload` 授权。它已经带着 contentId / uploader / deadline / signature */
  wire: UploadAuthWire
}): Promise<void> {
  // ⚠️ `wire` 直接铺开 —— 服务端要的五个字段都在里面,`title` 是它不碰的第六个
  // (见 `api/content-meta.ts`:`parseUploadAuth` 只认那五个)
  await postJson('/api/content-meta', { ...args.wire, title: args.title })
}

/**
 * 签名授权,组装出 `clientPayload`。
 *
 * 走 EIP-712(`shared/upload.ts` 的 `Upload` 消息),与解锁那条**共用 domain**,
 * 但类型和字段不同 —— 一条为"传预览图"签发的授权拿不去写 `content/`。
 */
export async function authorizeUpload(args: {
  contentId: Hex
  target: UploadTarget
  uploader: Address
  signTypedData: (data: ReturnType<typeof uploadTypedData>) => Promise<Hex>
}): Promise<UploadAuthWire> {
  const message: UploadMessage = {
    contentId: args.contentId,
    target: args.target,
    uploader: args.uploader,
    deadline: nextUploadDeadline(),
  }
  const signature = await args.signTypedData(uploadTypedData(message))
  return fromUploadMessage(message, signature)
}

/**
 * 直传文件到 Blob。
 *
 * ## 为什么是客户端直传
 *
 * **Function 的请求体上限是 4.5 MB**,而内容文件没有尺寸约束。
 * 所以文件从浏览器直接 PUT 到 Blob,只把"门票请求"发给我们的 Function。
 *
 * ## `multipart` 必须保持默认(false)
 *
 * SDK 的 `multipart: true` 会走"分片上传",而那条路要求服务端实现的是
 * **另一个回调**(`handleUploadPresigned`,返回一个 `/mpu` 的 presigned POST URL),
 * 不是我们用的 `handleUpload`。开着它会让整个上传在一个看起来很费解的地方失败。
 * 单次 PUT 对 200 MiB 以内的文件是够的 —— 那正是 `MAX_UPLOAD_BYTES` 的上限。
 */
export async function directUpload(args: {
  file: File
  target: UploadTarget
  pathname: string
  wire: UploadAuthWire
  onProgress?: (percentage: number) => void
}): Promise<void> {
  try {
    await upload(args.pathname, args.file, {
      // ⚠️ 必须与 store 的实际配置一致:私有 store 传 'public' 会被平台直接拒。
      // 两个 store 的划分见 `shared/storage.ts`
      access: args.target === 'content' ? 'private' : 'public',
      handleUploadUrl: '/api/upload',
      clientPayload: encodeUploadClientPayload(args.wire),
      // 显式带上,不让 SDK 从扩展名猜 —— 一个没有扩展名的文件会被猜成
      // `application/octet-stream`,买家下载下来打不开
      contentType: args.file.type || 'application/octet-stream',
      onUploadProgress: args.onProgress
        ? (p) => args.onProgress!(p.percentage)
        : undefined,
    })
  } catch (e) {
    // 走到这里的原因**只有日志留得下**(SDK 丢了响应体,见 `preflightUpload`)。
    // 归到 `unavailable` 是对的:预检已经把那几条"重试没用"的挑走了,
    // 剩下的大多是真·网络问题
    throw new UploadError(
      'unavailable',
      '文件没能传上去',
      e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    )
  }
}

/**
 * 把钱包那边抛出来的东西翻译成失败原因。
 *
 * `isUserRejection` 由调用方传入(它在 `lib/payErrors.ts`,与付款流程共用
 * 同一套判断)—— 不在这里 import 是为了让本文件不依赖付款那条链路。
 */
export function classifyUploadError(
  err: unknown,
  isUserRejection: (e: unknown) => boolean,
): UploadError {
  if (err instanceof UploadError) return err
  if (isUserRejection(err)) return new UploadError('user-rejected', '用户取消了签名')
  // 多半是钱包或 viem 抛的(chain 不匹配、钱包没实现 signTypedData 等)。
  // 归到"上游"是因为重试**可能**有用,而且详情会原样显示出来
  return new UploadError(
    'unavailable',
    '钱包签名失败',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  )
}

/** 签名消息的字段顺序 —— 导出给验证脚本断言用(顺序变了签名就永远验不过) */
export { UPLOAD_TYPES }
