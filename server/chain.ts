import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  fallback,
  http,
  type Address,
  type Hex,
} from 'viem'
import { creatorSplitterAbi } from '../shared/abi/creatorSplitter.js'
import { CHAIN, DEFAULT_RPC_BACKUP, DEFAULT_RPC_PRIMARY, DEPLOYED_SPLITTER } from '../shared/chain.js'
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
