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

/* ─────────────────────── W7 · Agent 付款凭据的防重放 ─────────────────────── */

/**
 * 防重放的键。
 *
 * ⚠️ **全局 `payment:${txHash}`,不加 contentId。** 一笔交易只可能付一件内容,
 * 跨 contentId 的重放由"收据里的 `contentId` 必须与请求一致"那条拦下
 * (见 `api/content/[id].ts` 的 ② )。加了 contentId 反而会开一个洞:
 * 同一笔交易在 A 内容下消费过之后,还能在 B 内容下再消费一次。
 */
function paymentKey(txHash: string): string {
  return `payment:${txHash}`
}

/**
 * 一笔付款的**临时占位**能活多久(秒)。
 *
 * 这是"从占位到落定"这段窗口的上限。设短的理由:占位期间**同一个 txHash
 * 的并发请求会被拒**(这正是防重放要的),但如果 Function 在占位之后、
 * 落定之前崩了,这个 txHash 在窗口内会**误判成已消费**。所以窗口要有界,
 * 而且越短越好 —— 60 秒够一次 RPC 往返 + 两次 KV 操作,绰绰有余。
 *
 * 反过来设计(先记后用)的失败模式是**永久锁死**:一个付了钱但响应失败的
 * agent 再也换不到内容。**60 秒是有界的,永久不是** —— 这就是选它的理由。
 */
export const PAYMENT_RESERVATION_TTL_SECONDS = 60

/**
 * 占一个 txHash —— **`SET NX`,并发下只有一个能进**。
 *
 * 方案对这件事有两条要求,而朴素实现做不到同时成立:
 *
 *   - 「同一个 `txHash` 并发请求 → 只有一次成功(KV 写入要原子)」→ 要求**先记**
 *   - 「"已消费"必须记在成功响应之后」→ 要求**后记**
 *
 * 解法是把它拆成**占位 → 落定**两步:先 `reservePayment` 用 `SET NX`
 * 原子地抢一个短租约(这条满足"原子"),等响应真的备好了再 `commitPayment`
 * (这条满足"记在成功之后"),中途任何失败都 `releasePayment` 放开。
 *
 * 与 `claimUploader` 一样:`NX` 而不是"先读再写" —— 后者在并发下会让
 * 两个请求都认为自己是第一个,而那正是这条防线唯一要防的事。
 */
export async function reservePayment(txHash: string, contentId: string): Promise<boolean> {
  const r = redis()
  if (!r) throw new Error('KV 未配置')
  const res = await r.set(paymentKey(txHash), contentId, {
    nx: true,
    ex: PAYMENT_RESERVATION_TTL_SECONDS,
  })
  return res === 'OK'
}

/**
 * 落定 —— 交易真的被消费了。**必须在成功响应准备好之后调。**
 *
 * ⚠️ **不设 TTL(即"永久")。** 这是刻意的:一笔交易只能换一次内容,
 * 而"多久之后重放就无害了"没有正确答案。看起来设个一年也行,但要问
 * "那时候为什么就安全了"—— 答案是"因为第 ⑤ 条(报价有效期)早就拦住了",
 * 也就是说 TTL 并没有在保护什么,只是让过期后的行为变得更难推理。
 *
 * 存储代价可以忽略:一个键值几十字节,演示量级下永远到不了需要清理的时候。
 * 真要清,得先想清楚"这一条被清掉之后会发生什么"。
 */
export async function commitPayment(txHash: string, contentId: string): Promise<void> {
  const r = redis()
  if (!r) throw new Error('KV 未配置')
  // 不带 ex ⇒ 去掉 reserve 留下的 TTL
  await r.set(paymentKey(txHash), contentId)
}

/** 放开占位 —— 校验失败时调,让 agent 能**原样重试** */
export async function releasePayment(txHash: string): Promise<void> {
  const r = redis()
  if (!r) return
  await r.del(paymentKey(txHash))
}

/**
 * 这个 txHash 是否已经落定(不是占位)。
 *
 * ⚠️ **不区分"占位中"和"已落定"** —— 两者都算"已消费",调用方对它们的反应
 * 完全一样(拒)。分成两个函数只会让调用方有机会选错那一个。
 */
export async function isPaymentConsumed(txHash: string): Promise<boolean> {
  const r = redis()
  if (!r) return false
  return (await r.exists(paymentKey(txHash))) > 0
}

/* ─────────────────────── W7 · 内容的易读信息(标题) ─────────────────────── */

/**
 * 标题的键。
 *
 * ⚠️ 方案 §10 原话说"体验模式的 demo-pay 顺手把易读记录写进 KV,属于 W8"。
 * **这里提前做了,而且做在 `content-meta` 这个独立端点上** —— 因为 catalog
 * 必须返回 `title`,而链上不存标题、服务端此前零来源(见 `docs/W7-实施计划.md` §4.3)。
 * W8 要写别的易读字段时,用**同一个前缀**、同一个端点扩展,别再开一个新键空间。
 */
function titleKey(contentId: string): string {
  return `meta:${contentId}`
}

/**
 * 写一条标题。
 *
 * ⚠️ 值在**进这里之前**必须已经过 `normalizeTitle`(见 `shared/contentMeta.ts`)。
 * 本函数不做截断 —— 把校验放在存储层会让"哪里该管什么"变得含糊,
 * 而且 `shared/` 那份才是两端共用的同一套规则。
 */
export async function setContentTitle(contentId: string, title: string): Promise<void> {
  const r = redis()
  if (!r) throw new Error('KV 未配置')
  await r.set(titleKey(contentId), title)
}

/** 读一条标题。没有就返回 `null` —— "没标题"和"标题是空串"必须能分开 */
export async function getContentTitle(contentId: string): Promise<string | null> {
  const r = redis()
  if (!r) return null
  const value = await r.get<string>(titleKey(contentId))
  return value ?? null
}

/**
 * 批量读标题 —— `/api/catalog` 用。
 *
 * ⚠️ **不要写成 catalog 里逐条 `getContentTitle`。** 那样 N 件内容就是 N 次
 * 网络往返,而 catalog 是 agent **每次开始都要打**的端点(方案 §9.4 第 0 步
 * 就是"发现")。一次 `mget` 拿完。
 *
 * 返回的 Map 的键是**小写** contentId —— 与 `deriveActiveState` 同一条纪律
 * (事件里的 contentId 是 hex,viem 解码后是小写;别处来的不保证)。
 */
export async function getContentTitles(contentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (contentIds.length === 0) return out

  const r = redis()
  if (!r) return out

  const values = await r.mget<(string | null)[]>(...contentIds.map(titleKey))
  contentIds.forEach((id, i) => {
    const value = values[i]
    if (typeof value === 'string') out.set(id.toLowerCase(), value)
  })
  return out
}
