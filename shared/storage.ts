import type { Hex } from 'viem'

/**
 * 两个 Blob store 的 pathname 约定 —— **前端拼、服务端校验,所以两端共用这一份**。
 *
 * ## 布局(方案 §9.1 的落地形态)
 *
 * ```
 * Blob(私有 store)   content/<contentId>   内容文件,永不可公开读
 * Blob(公开 store)   preview/<contentId>   预览图,CDN 直出
 * ```
 *
 * **为什么是两个 store**:`access` 是 **store 级**配置且**平台强制** ——
 * 在私有 store 里 `put --access public` 会被平台直接拒掉(2026-09-23 实测)。
 * 所以"内容私有 + 预览公开"在一个 store 里表达不出来。
 *
 * ⚠️ **前缀两个形态下都必须保留。** 它是"这行指向付费内容还是预览图"的唯一依据,
 * 也是服务端判断一个上传请求该用哪个 store 的凭证的唯一依据。
 * 别因为落在两个 store 就把它简化掉。
 *
 * ## pathname 是**确定性**的,不掺随机数(2026-09-23 决策 甲)
 *
 * 曾考虑过用 `addRandomSuffix` 让路径不可猜,代价是要靠 `onUploadCompleted`
 * 回调把真实 pathname 写回 KV —— 而那个回调需要一个**公网可达的地址**,
 * 本地开发(localhost)根本收不到。为了让本地能跑,选了确定性 pathname。
 *
 * 不掺随机数**不等于**放弃防覆盖:平台侧 `allowOverwrite` **默认就是 false**,
 * 写向一个已存在的 pathname 会直接被拒。见下面 `UPLOAD_TOKEN_*` 的注释。
 */

/** 私有 store 的前缀 —— 付费内容 */
export const CONTENT_PREFIX = 'content/'

/** 公开 store 的前缀 —— 预览图 */
export const PREVIEW_PREFIX = 'preview/'

/** 一次上传往哪个 store 落 —— 也就是客户端要传的是内容还是预览图 */
export type UploadTarget = 'content' | 'preview'

const PREFIX_BY_TARGET: Record<UploadTarget, string> = {
  content: CONTENT_PREFIX,
  preview: PREVIEW_PREFIX,
}

/**
 * contentId 的严格形状:**小写** `0x` + 64 位十六进制。
 *
 * ⚠️ **刻意不接受大写**,这不是洁癖 —— 如果大小写都算合法,同一个 contentId
 * 就能对应 2^N 个不同的 pathname,而 `allowOverwrite` 是**按 pathname 逐字节**
 * 判重的。那样一来"同一个 contentId 只写一次"这个保证就没了:攻击者往
 * `content/0xABC…` 传一份,平台会认为那是个全新的 blob,痛快放行。
 * 客户端一律走下面的构造函数,产出天然是小写,所以这个限制不会误伤。
 */
const CONTENT_ID_RE = /^0x[0-9a-f]{64}$/

/**
 * `contentId` 的形状判断 —— 路由校验入参用。
 *
 * ⚠️ 与 `shared/eip712.ts` 的 `isBytes32` **不是一回事,别互相替换**:
 * `isBytes32` 只判"是不是 32 字节 hex",大小写都收;这里**只收小写**,
 * 理由是上面那段(大小写会让同一个 contentId 对应多个 pathname,
 * 从而绕过 `allowOverwrite` 的逐字节判重)。
 */
export function isContentId(value: unknown): value is Hex {
  return typeof value === 'string' && CONTENT_ID_RE.test(value)
}

/**
 * 一条合法 pathname 的完整形状。
 *
 * 正则**锚定首尾 + 只允许 `[0-9a-f]`**,所以路径穿越(`../`)、
 * 多段路径、空段、编码过的字符**在结构上就不可能出现** ——
 * 不需要再单独写一条"防穿越"的检查。
 */
const PATHNAME_RE = /^(content|preview)\/(0x[0-9a-f]{64})$/

/**
 * 校验并**拆解**客户端提交的 pathname。
 *
 * 服务端在签发上传 token 前必须过这一关。非法一律返回 `null`
 * (而不是抛异常)——理由同 `shared/unlock.ts` 的 `parseUint256`:
 * 输入校验的失败路径必须是返回值,否则任何访客都能用一行畸形输入换一个 500。
 *
 * ⚠️ 拆出来的 `target` / `contentId` 只是"这条 pathname 声称自己是什么"。
 * **真正要签发的 pathname 必须由服务端自己用下面的构造函数重算一遍再做相等比较** ——
 * 用重算值,不要用这里的解析值,哪怕两者当前等价。
 */
export function parseUploadPathname(raw: unknown): { target: UploadTarget; contentId: Hex } | null {
  if (typeof raw !== 'string') return null
  const m = PATHNAME_RE.exec(raw)
  if (!m) return null
  return { target: m[1] as UploadTarget, contentId: m[2] as Hex }
}

/**
 * 拼一条 pathname。**客户端用它构造、服务端用它重算期望值** ——
 * 同一个函数,所以"客户端提交的"和"服务端期望的"不可能因为拼法不同而错位。
 */
export function uploadPathname(target: UploadTarget, contentId: Hex): string {
  if (!isContentId(contentId)) {
    // contentId 来自 `generateContentId()`(32 字节密码学随机)或 URL 解析,
    // 走到这里说明上游漏了校验。宁可当场炸,也不要拼出一条畸形 pathname
    // 去签发 token —— 那等于把一个不该存在的路径写进了 store。
    throw new Error(`uploadPathname: contentId 形状非法: ${String(contentId)}`)
  }
  return `${PREFIX_BY_TARGET[target]}${contentId}`
}

/** 付费内容的 pathname(私有 store)。服务端签下载 URL 时也用它 */
export function contentPathname(contentId: Hex): string {
  return uploadPathname('content', contentId)
}

/** 预览图的 pathname(公开 store) */
export function previewPathname(contentId: Hex): string {
  return uploadPathname('preview', contentId)
}

/**
 * 上传 token 的体积上限(字节)。
 *
 * 这不是产品限制,是**泄露后的止损阀**:token 有效期短、又绑死一条 pathname,
 * 万一被拿到,能造成的浪费也就这么一坨。不加的话上限等于 store 的总配额。
 *
 * 内容给 200 MiB:演示素材(视频/图/PDF)够用,又远小于任何套餐配额。
 * 预览图给 8 MiB:它是给买家看的图,大到 8 MiB 已经不是预览图了。
 */
export const MAX_UPLOAD_BYTES: Record<UploadTarget, number> = {
  content: 200 * 1024 * 1024,
  preview: 8 * 1024 * 1024,
}

/**
 * 预览图只收图片。
 *
 * 内容**刻意不限类型** —— 创作者传什么都有可能(PDF/视频/压缩包),
 * 列白名单会把正常用法挡在外面。代价是任何人只要拿到 token 就能往
 * 私有 store 里放一个 HTML 文件;但那个 store 是私有的,文件只能通过
 * 60 秒签名 URL 取出,而 blob 域名与本应用**不同源**,所以不构成
 * 对本应用的 XSS 面。这条边界要如实记在方案 §20。
 */
export const ALLOWED_CONTENT_TYPES: Record<UploadTarget, string[] | undefined> = {
  content: undefined,
  preview: ['image/*'],
}

/**
 * 上传 token 的有效期(毫秒)。
 *
 * 从"服务端签发"起算,不是从"客户端开始传"起算 —— 所以它必须容得下
 * **大文件真正传完**的时间。取得太短会让大文件传到一半 token 失效。
 * 15 分钟:200 MiB 在 1 Mbps 的烂网络下约 27 分钟(那种情况本来也会超时),
 * 正常网速下绰绰有余。
 */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000
