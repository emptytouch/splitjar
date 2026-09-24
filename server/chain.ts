import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'
import { creatorSplitterAbi } from '../shared/abi/creatorSplitter.js'
import { inWindows } from '../shared/blockWindows.js'
import {
  CHAIN,
  DEFAULT_RPC_BACKUP,
  DEFAULT_RPC_PRIMARY,
  DEPLOYED_SPLITTER,
  DEPLOY_BLOCK,
} from '../shared/chain.js'
import { serverEnv } from './env.js'

/**
 * 服务端读链 —— 门禁的**信任面**在这里。
 *
 * ## ⚠️ 这是"读一个我们信任的 RPC 的付费墙",不是"经过验证的付费墙"(方案 §5.1)
 *
 * 前端读链走的是浏览器里的钱包 RPC;服务端读链走的是**我们在环境变量里配的** RPC。
 * 这意味着:**RPC 说谎,门禁就判错。** 对一个演示产品可以接受,但必须说清楚 ——
 * 别把它包装成它做不到的保证。
 *
 * 真要更硬,得自己跑节点或验轻客户端证明,那是另一个量级的事,不在 W5 范围内。
 *
 * ## 读的是"当前链上的值"
 *
 * 走 JSON-RPC `eth_call`(POST),**没有 CDN 缓存可言** —— 方案里提到的
 * `cache: false` 是 Blob SDK 签发 URL 那边的选项,与这里无关,别搞混。
 * 默认 `blockTag` 就是 `latest`,下面显式写出来是为了让"要当前值"这件事
 * 在代码里看得见。
 */

/**
 * 合约地址。
 *
 * `SPLITTER_ADDRESS` 环境变量优先,缺省回落 `shared/chain.ts` 的已部署常量
 * —— 与前端 `src/lib/splitter.ts` 完全同一个写法,只是两端各自读自己的 env。
 * 这样**两边缺省时必然指向同一个合约**。
 */
export const SPLITTER_ADDRESS = (serverEnv('SPLITTER_ADDRESS') ??
  DEPLOYED_SPLITTER) as Address

/**
 * 主备两条 RPC。默认值取自 `shared/chain.ts` —— 与网页自己读链用的是
 * **同一组默认端点**。默认值不一致会造成"网页说买了、服务端说没买"这种
 * 最难排查的分歧。
 */
const PRIMARY = serverEnv('RPC_PRIMARY') ?? DEFAULT_RPC_PRIMARY
const BACKUP = serverEnv('RPC_BACKUP') ?? DEFAULT_RPC_BACKUP

/**
 * `rank: false` —— 固定主备顺序,不做延迟竞速。
 * 理由同前端 `src/lib/rpc.ts`:演示要的是"可预测",不是"最快"。
 */
export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: fallback([http(PRIMARY), http(BACKUP)], { rank: false, retryCount: 1 }),
})

/**
 * 链上 `purchases[contentId][buyer]` —— 门禁的**唯一依据**。
 *
 * 已经是 `view` 函数,读它不会 revert。但**RPC 挂掉时它会抛** ——
 * 这里刻意**不吞异常**:调用方必须把"读不到"和"没买"区分开。
 * 前者应该回 503(服务有问题),后者才回 401(你没买)。
 * 把前者当后者会让一次 RPC 抖动变成"用户明明买了却被告知没买"。
 */
export async function hasPurchased(contentId: Hex, buyer: Address): Promise<boolean> {
  return publicClient.readContract({
    address: SPLITTER_ADDRESS,
    abi: creatorSplitterAbi,
    functionName: 'purchases',
    args: [contentId, buyer],
    blockTag: 'latest',
  })
}

/**
 * 读内容的创建者。**内容还没注册时返回 `null`。**
 *
 * ## ⚠️ 这里有一个必须守住的区分
 *
 * `getContent` 对不存在的 contentId 会 **revert `ContentNotFound`**(合约的自定义
 * error,已从 ABI 核实)。所以:
 *
 *   - 明确 revert `ContentNotFound`  → 返回 `null`(内容确实不存在)
 *   - **其它任何错误(RPC 挂、超时、返回垃圾)→ 往外抛**
 *
 * 这个区分不是洁癖,是**安全性**的:上传授权要用它判断"这个 contentId 是不是
 * 已经属于别人了"。如果把"RPC 读不到"也当成"不存在",那么一次 RPC 抖动就会让
 * 门禁**放行**一次本该拒绝的上传 —— 那是 fail-open。
 *
 * 顺带:不按"creator == 0x0 就当不存在"来判。合约的 `ContentNotFound` 才是
 * 官方口径,自己另立一套判断等于把合约的语义抄了一遍,抄错了没人会发现。
 */
export async function getContentCreator(contentId: Hex): Promise<Address | null> {
  try {
    // ⚠️ viem 对**多返回值**函数返回的是**元组(按位置)**,不是首元素 ——
    // 所以这里必须解构,不能直接当 Address 用。(与前端 `toContent` 面对的是
    // 同一个特性,那份注释在 `src/lib/splitter.ts`。)
    // 只要第一位:服务端目前只需要创建者,别把整个 Content 拖进来。
    const [creator] = await publicClient.readContract({
      address: SPLITTER_ADDRESS,
      abi: creatorSplitterAbi,
      functionName: 'getContent',
      args: [contentId],
      blockTag: 'latest',
    })
    return creator
  } catch (error) {
    if (isContentNotFound(error)) return null
    throw error
  }
}

/**
 * 认一下这个错误是不是"内容不存在"。
 *
 * viem 会把 revert 包成 `ContractFunctionRevertedError`,自定义 error 的名字在
 * `data.errorName` 上。**只认这一个名字** —— 不认"里面提到了 ContentNotFound
 * 字样"那种模糊匹配,因为错误消息里出现这个字样不代表 revert 的就是它。
 */
function isContentNotFound(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
  return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'ContentNotFound'
}

/* ─────────────────────────── W7 · Agent 路径要读的东西 ─────────────────────────── */

/** 一件内容在链上的、我们关心的那几项 */
export type ContentInfo = {
  creator: Address
  /** 原始单位(USDC 6 位小数) */
  price: bigint
  active: boolean
}

/**
 * 读一件内容的 `creator / price / active`。**内容不存在返回 `null`。**
 *
 * 与 `getContentCreator` 是**两条独立的读**,不是"一个包另一个" ——
 * 刻意不用 `getContent` 的全量返回值(那条还带着 `recipients` / `splits`
 * 两个动态数组,解码开销与返回体积都白搭)。这里只要三个字段。
 *
 * ⚠️ 失效方向与 `getContentCreator` **完全一致**:只有明确 revert
 * `ContentNotFound` 才返回 `null`,其它任何错误(RPC 挂、超时)一律**往外抛**。
 * 把"读不到"当成"不存在"会让一次 RPC 抖动把 `GET /api/content/:id`
 * 变成 404 —— 而 agent 对 404 的正确反应是放弃,对 503 才是重试。
 */
export async function getContentInfo(contentId: Hex): Promise<ContentInfo | null> {
  try {
    // ⚠️ viem 对**多返回值**函数返回的是**元组(按位置)**。只解我们需要的三个,
    // 把 `contentHash` 那格用 `_` 占位 —— 顺序以 `RawContent` 为准,别数错。
    const [creator, price, , , , active] = await publicClient.readContract({
      address: SPLITTER_ADDRESS,
      abi: creatorSplitterAbi,
      functionName: 'getContent',
      args: [contentId],
      blockTag: 'latest',
    })
    return { creator, price, active }
  } catch (error) {
    if (isContentNotFound(error)) return null
    throw error
  }
}

/**
 * 从交易收据里取出这笔交易到底付了什么 —— **第 ①②③ 条校验的全部依据**。
 *
 * ## ⚠️ 为什么这三条塌缩成一次读(方案没规定,本包定的判据)
 *
 * 方案的原文是「`txHash` 已上链且**确认数达标**」+「事件里 `contentId` 一致」
 * +「事件里 `payer` 一致」。**但"确认数达标"是几个确认,文档从头到尾没有规定。**
 *
 * 这里**不引入确认数阈值**,判据换成:
 *
 * ```
 * 收据存在 且 status === 'success'
 *   → ① 过
 * 收据里存在 PaymentSplit 日志(其 contentId 由调用方去比对)
 *   → ② 过(第 ② 条要求日志本身在场,所以收据必然已存在且成功)
 * 该日志的 payer 由调用方比对
 *   → ③ 过
 * ```
 *
 * **为什么这样比"N 个确认"好**:确认数是一个**拍出来的数字**,
 * 而"收据成功 + `PaymentSplit` 日志在场"是**确定性的**。而且第 ② 条本来就
 * 要求日志在场,所以它把第 ① 条的存在性检查**顺带**满足了 —— 三个检查
 * 塌缩成一次读,没有额外的等待。
 *
 * ⚠️ **代价是没有 reorg 保护。** 一个极深的 reorg 可能让一笔已被读到的交易
 * 消失,而我们已经把内容交付了。**在 Fuji 演示场景下可以接受**
 * (Fuji 的 reorg 极罕见,且交付的是短时效 URL)。
 * **要上主网,这里必须改成"等 N 个确认"** —— 别把这个判据当成可以照搬的。
 *
 * ## 返回值
 *
 * - `null` —— 没有收据,或收据 `status !== 'success'`(即第 ① 条失败)
 * - 数组 —— 这笔交易里**所有**的 `PaymentSplit` 日志。正常情况下只有一条
 *   (`pay()` 只发一次),但一笔交易理论上可以调多次 `pay()`,
 *   所以返回全部,由调用方按 `contentId` 挑。
 *
 * ⚠️ **只读,不做任何判断。** 匹配 `contentId` / `payer` 的策略留在路由里 ——
 * 这样"哪一条日志算数"是一个能单独测的纯逻辑,而不是藏在一次 RPC 调用后面。
 *
 * ## ⚠️ 为什么把 `amounts` 也带出来
 *
 * 因为路由要拿 `sum(amounts) === 当前链上价格` 来**替代**"把金额签进报价"那条
 * 路(推演见 `server/quote.ts` 文件头)。那个和**必然**等于付出去的总额:
 * 合约 `pay()` 里 `uint256 amount = c.price`,而分账循环把余数归给最后一个
 * 收款人,`distributed` 最终恰好收敛到 `amount` —— 所以求和与"到底付了多少"
 * 是同一个数,不需要另存。
 *
 * ⚠️ 别在这里就地求和:路由需要的是**每一条日志各自的**金额,
 * 因为它要挑出属于这件内容的那一条再求和,而不是把一笔交易里所有 `pay()`
 * 的金额混在一起。
 */
export async function getPaymentSplits(txHash: Hex): Promise<
  Array<{ contentId: Hex; payer: Address; amounts: readonly bigint[]; blockTimeSeconds: number }> | null
> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
  // `status` 是 `'success' | 'reverted'`。**只认 success** ——
  // 一笔 revert 掉的交易不该能换到任何东西,哪怕它里面碰巧有日志
  // (revert 的交易在链上是没有日志的,但这里不做假设)。
  if (receipt.status !== 'success') return null

  const logs = parseEventLogs({
    abi: creatorSplitterAbi,
    logs: receipt.logs,
    eventName: 'PaymentSplit',
  })
  if (logs.length === 0) return []

  // 区块时间戳不在收据里,得单独读一次块。**这一步是第 ⑤ 条(报价有效期)的前提** ——
  // 没有它就没法判"这笔交易发生在报价窗口内"。
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })

  return logs.map((log) => ({
    contentId: log.args.contentId,
    payer: log.args.payer,
    // `pay()` 里 `amounts[i] = share`,余数归最后一个收款人 ⇒ 求和恒等于 `c.price`。
    // 事件里它是 `uint256[]`,viem 解出来是 `readonly bigint[]` —— 别改成 `number`
    amounts: log.args.amounts,
    // ⚠️ viem 的区块时间戳是 **bigint 秒**。转成 number 是安全的:
    // unix 秒远小于 2^53,而下游(报价的 issuedAt/expiresAt)本来就是 number。
    blockTimeSeconds: Number(block.timestamp),
  }))
}

/** catalog 的原料:一件已注册内容在链上的不可变字段 */
export type RegisteredContent = {
  contentId: Hex
  creator: Address
  price: bigint
}

/**
 * 扫出所有已注册的内容 —— `/api/catalog` 的起点。
 *
 * ## ⚠️ 为什么只扫事件、完全不读 `getContent`
 *
 * 因为**`price` 与 `creator` 在注册之后不可变** —— 已从合约 ABI 核实:
 * 全部函数只有 `contentExists` / `createContent` / `getContent` / `pay` /
 * `pendingBalance` / `purchases` / `setContentActive` / `usdc` / `withdraw`,
 * **没有任何改价或转移归属的入口**。唯一可变的是 `active`,
 * 而它由 `ContentActiveChanged` 事件单独记录。
 *
 * 所以 `ContentRegistered` 里那份 `price` 与 `creator` **永远等于当前值**,
 * 拿它建列表不会有一个"N 件内容就 N 次 `eth_call`"的开销。
 * 真读了 `getContent` 反而更慢,而且**结果完全一样**。
 *
 * ## 起点必须用 `DEPLOY_BLOCK`
 *
 * `shared/chain.ts` 那个常数的注释写明它是"服务端事件索引的起点,**不要另写一份**"。
 * 从 0 开始扫会在公共 RPC 上被拒(范围过大),从 `latest` 开始会漏掉全部内容。
 *
 * ## ⚠️ 2026-09-24:`fromBlock → latest` 一次扫完**已经不行了**,必须切窗口
 *
 * 这里原来是一次 `getContractEvents` 从 `DEPLOY_BLOCK` 扫到 `'latest'`,
 * 依据是"公共 Fuji RPC 不限制 `getLogs` 范围"。**那个依据已过期** ——
 * 备端点 `publicnode` 的上限是 50,000 块,而跨度是 158,401(且只涨不减)。
 * 后果是**主备只剩一条腿**:主端点不可达时 fallback 走到备端点、备端点拒收范围、
 * 抛出的 `RpcRequestError` 不会被 fallback 吞掉,直接冒成 503。
 *
 * 完整实测与推导见 `shared/blockWindows.ts` 文件头 + `docs/W8-实施计划.md` §十一。
 *
 * ## ⚠️ `toBlock` 是**传进来的**,不是在这里读 `'latest'`
 *
 * 理由不是省一次 RPC,是**正确性**:`/api/catalog` 要把 `blockNumber` 一起返回,
 * 让"这份列表是哪个高度上的"这句话真的成立。如果这里各自解析 `'latest'`,
 * 两次扫链与那次读块号可能落在**三个不同高度**上,响应里的 `blockNumber` 就成了
 * 一句没有依据的话。
 *
 * 用一个**具体块号**当上界还有第二个好处:一个响应内部的两次扫链**看的是同一个高度**,
 * 不会出现"注册事件扫到了、上下架事件没扫到"这种自己跟自己不一致的列表。
 *
 * ## ⚠️ `strict: true` 不是可选的,少了它类型就废了
 *
 * 不加 `strict` 时 viem 把返回值定型成**整个 ABI 里所有事件的联合**,
 * 于是 `log.args.contentId` 的类型是 `Hex | undefined` —— 因为 ABI 里
 * 有些事件压根没有这个字段。加了 `strict: true` 才真正按 `eventName` 收窄成
 * `ContentRegistered` 一种,`args` 变成必填。
 *
 * ⚠️ 别用 `log.args.contentId!` 把它按下去:那是在对一个**真实的可能性**
 * 撒谎(也挡不住将来有人把 `eventName` 改错)。
 * ⚠️ 也别为了复用而把 `strict: true` 挪进 `shared/blockWindows.ts` 的泛型里 ——
 * 那正是它被写成"纯函数 + 回调"的原因,见那个文件头的第 1 条。
 */
export async function listRegisteredContents(toBlock: bigint): Promise<RegisteredContent[]> {
  // ⚠️ `getContractEvents` 放在回调里,`strict: true` 才不会被磨掉 —— 见 `shared/blockWindows.ts` 的三条理由
  const logs = await inWindows(DEPLOY_BLOCK, toBlock, (from, to) =>
    publicClient.getContractEvents({
      address: SPLITTER_ADDRESS,
      abi: creatorSplitterAbi,
      eventName: 'ContentRegistered',
      fromBlock: from,
      toBlock: to,
      strict: true,
    }),
  )
  return logs.map((log) => ({
    contentId: log.args.contentId,
    creator: log.args.creator,
    price: log.args.price,
  }))
}

/**
 * 扫出所有的上下架变更 —— 交给 `shared/contentActive.ts` 的 `deriveActiveState` 收敛。
 *
 * ⚠️ **不要在这里顺手做收敛。** 那一步最容易写错的正是**遍历顺序**
 * (顺序反了会给出上一次的状态,而且切一次看不出来、连着切两次才暴露),
 * 所以它被抽成一个**不碰链、能单独测**的纯函数。
 * 这里只负责"按 viem 的顺序把它捞出来"(区块升序 + 同区块内 logIndex 升序)。
 *
 * ⚠️ 切窗口与 `toBlock` 必须是传进来的理由,同 `listRegisteredContents` ——
 * 一句话:**"不限制范围"那条依据过期了,而两次扫链必须看同一个高度。**
 *
 * ⚠️ `strict: true` 的理由同 `listRegisteredContents` —— 少了它 `args` 全是
 * `| undefined`,类型检查等于没做。
 */
export async function listActiveChanges(
  toBlock: bigint,
): Promise<Array<{ contentId: string; active: boolean }>> {
  const logs = await inWindows(DEPLOY_BLOCK, toBlock, (from, to) =>
    publicClient.getContractEvents({
      address: SPLITTER_ADDRESS,
      abi: creatorSplitterAbi,
      eventName: 'ContentActiveChanged',
      fromBlock: from,
      toBlock: to,
      strict: true,
    }),
  )
  return logs.map((log) => ({ contentId: log.args.contentId, active: log.args.active }))
}
