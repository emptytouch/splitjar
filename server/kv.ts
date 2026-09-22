import { randomBytes } from 'node:crypto'
import { Redis } from '@upstash/redis'
import { NONCE_TTL_SECONDS } from '../shared/unlock.js'
import { serverEnv } from './env.js'

/**
 * Redis(Upstash)—— nonce 与后续的限额/防重放都落在这里。
 *
 * ## ⚠️ 库换了,变量名没换
 *
 * `@vercel/kv` **已于 2024-12 废弃**,KV 并入 **Upstash Redis**
 * (Vercel Marketplace 集成)。但 `Redis.fromEnv()` 对
 * `UPSTASH_REDIS_REST_*` 和 `KV_REST_API_*` **两套名字都认**
 * (`UPSTASH_*` 优先),而 Vercel 集成注入的正是兼容旧名的那套 ——
 * 所以 `server/env.ts` 里登记的两个名字保持原样(2026-09-23 核实)。
 *
 * ## 为什么把 nonce 的"看一眼"和"用掉"拆成两个函数
 *
 * 方案 §9.2 记了一条教训:
 *
 * > **先删再干活,后面失败用户就得重新签名。**
 *
 * 也就是说"删除 nonce"必须发生在**全部检查通过之后**。光靠注释提醒是靠不住的
 * —— 所以这里不给调用方一个"顺手删掉"的机会:要读 nonce 只能走 `peekNonce`
 * (**只读不删**),`consumeNonce` 单列,名字本身就说明了它该在最后一步调。
 *
 * ## 失效方向:**fail closed**
 *
 * Redis 用不了的时候,所有函数一律返回"没有" —— 拿不到 nonce 就签不出合法请求,
 * 门禁因此**拒绝服务**,而不是**放行**。反过来做(连不上就跳过 nonce 校验)
 * 会让门禁退化成"可重放",那正是 §9.2 要防的。
 */

/**
 * Redis 客户端。**惰性构造 + 缓存**。
 *
 * 为什么不像 `rpc.ts` 那样在模块顶层直接建:构造时如果环境变量缺失,
 * `Redis.fromEnv()` 会**抛异常**,而模块顶层的异常会让整个 Function
 * 连 `import` 都过不去 —— 那样 `/api/health` 也一并挂掉,
 * 而 health 恰恰是用来诊断"还差哪个变量"的地方。
 */
let cached: Redis | null = null

function redis(): Redis | null {
  if (cached) return cached
  // 两个变量都在才建。缺任何一个都当作"未配置"而不是"配置错了"——
  // 本地克隆下来没配 KV 时,应该看到清晰的降级,而不是一堆连接错误。
  if (!serverEnv('KV_REST_API_URL') || !serverEnv('KV_REST_API_TOKEN')) return null
  cached = Redis.fromEnv()
  return cached
}

/** KV 是否已配置 —— 给 `/api/health` 和路由做降级判断用 */
export function kvConfigured(): boolean {
  return Boolean(serverEnv('KV_REST_API_URL') && serverEnv('KV_REST_API_TOKEN'))
}

/**
 * nonce 的键。
 *
 * 值是**它被签给哪个 contentId** —— 绑定之后,一个为 A 内容签发的 nonce
 * 不能拿去解锁 B。这不是防重放本身需要的(那是 `del` 的功劳),
 * 而是把"这个 nonce 是干嘛用的"写进存储,免得它变成一个万能通行证。
 */
function nonceKey(nonce: string): string {
  return `nonce:${nonce}`
}

/** `contentId → 首次获准上传的地址` 的键(见 `claimUploader`) */
function uploaderKey(contentId: string): string {
  return `uploader:${contentId}`
}

/**
 * 生成一个一次性 nonce —— **十进制字符串,因为它要进 EIP-712 的 `uint256`**。
 *
 * 不能用 `randomUUID()`:那产出的是带连字符的十六进制,`uint256` 装不下,
 * 而它在签名类型里就是这个类型。所以取 32 字节密码学随机再转十进制
 * (32 字节恰好就是 uint256 的宽度,不需要取模)。
 *
 * 随机性本身不是这条防线的关键(攻击者拿到 nonce 也签不出受害者的名),
 * 但它保证了不同用户之间的 nonce **不会撞车** —— 撞了就是一个人的作废
 * 会让另一个人的请求失败。
 *
 * 写入失败(Redis 挂了)时抛异常,由路由转成 503。**不返回 null 让调用方
 * 去猜** —— 这里只有"成功"和"抛"两种结果。
 */
export async function issueNonce(contentId: string): Promise<string> {
  const r = redis()
  if (!r) throw new Error('KV 未配置')
  const nonce = BigInt(`0x${randomBytes(32).toString('hex')}`).toString()
  await r.set(nonceKey(nonce), contentId, { ex: NONCE_TTL_SECONDS })
  return nonce
}

/**
 * 看一眼 nonce 对应的 contentId —— **只读,不删**。
 *
 * 拿不到(没配 KV / 不存在 / 已过期 / 已被用掉)一律返回 `null`,
 * 调用方无从区分,也不需要区分:对这四种情况,正确的反应都是拒绝。
 */
export async function peekNonce(nonce: string): Promise<string | null> {
  const r = redis()
  if (!r) return null
  const value = await r.get<string>(nonceKey(nonce))
  return value ?? null
}

/**
 * 用掉一个 nonce —— **必须在全部检查通过、且成功响应已经准备好之后才调**。
 *
 * 返回 `true` 表示这次真的由本调用删掉了(即 nonce 之前存在)。
 * `false` 有两种来源:nonce 本来就不在,或者没配 KV —— 两种情况调用方
 * 都应该当作失败处理(并发下第二个请求会拿到 `false`,这正是防重放的落点)。
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  const r = redis()
  if (!r) return false
  const deleted = await r.del(nonceKey(nonce))
  return deleted > 0
}

/**
 * 认领一个 contentId 的上传权 —— **`SET NX`,先到先得**。
 *
 * 返回 `true` 表示本次调用认领成功(该 contentId 此前没有归属);
 * `false` 表示已经有主了,调用方应当比对地址是否相同再决定放不放行。
 *
 * ## 安全根据是 contentId 本身猜不到
 *
 * `contentId` 由前端 `generateContentId()` 用 `crypto.getRandomValues`
 * 生成 32 字节随机数(见 `src/lib/splitter.ts`)。攻击者**无法预先猜到**
 * 一个创作者还没上传的 contentId,所以"先到先得"不会变成"谁先抢到算谁的"。
 *
 * ## 但要如实说清:这不防"存储配额被刷"
 *
 * 任何人都能自己生成一个 contentId、用自己的钱包签个名、上传一份文件 ——
 * EIP-712 证明的是**身份**,不是**授权**,它挡不住"一个愿打一个愿挨"式的滥用。
 * 真正要限流得靠 W6 的限额三件套,或者给每个地址配额度。
 * 这条边界记在方案 §20,别把这里包装成它做不到的事。
 *
 * 用 `NX` 而不是"先读再写":并发下先读再写会让两个请求都认为自己是第一个。
 */
export async function claimUploader(contentId: string, uploader: string): Promise<boolean> {
  const r = redis()
  if (!r) throw new Error('KV 未配置')
  const res = await r.set(uploaderKey(contentId), uploader, { nx: true })
  return res === 'OK'
}

/** 读一个 contentId 的上传权归属。没有归属返回 `null` */
export async function getUploader(contentId: string): Promise<string | null> {
  const r = redis()
  if (!r) return null
  const value = await r.get<string>(uploaderKey(contentId))
  return value ?? null
}
