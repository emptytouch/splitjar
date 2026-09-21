import type { Address, Hex } from 'viem'
import { creatorSplitterAbi } from '../../shared/abi/creatorSplitter'
import { DEPLOYED_SPLITTER } from '../../shared/chain'

/**
 * `CreatorSplitter` 的前端接入点 —— **读 ABI、地址、contentId 规则的唯一出处**。
 *
 * ABI 是**生成的**,别手抄、也别在这里另定义合约类型:
 * `cd contracts && node script/export-abi.mjs`
 */

export { creatorSplitterAbi }

/**
 * 当前使用的合约地址。
 *
 * `VITE_SPLITTER_ADDRESS` 优先,缺省回落到 `shared/chain.ts` 里的已部署常量 ——
 * 这样**克隆下来不配任何环境变量也能跑**(地址是公开的测试网部署,不是秘密)。
 *
 * ⚠️ `VITE_` 前缀的东西会被**内联进前端产物**,所以这里只能放公开值。
 * 私钥或服务端密钥用了这个前缀就等于公开,见 `server/env.ts` 的白名单。
 */
export const SPLITTER_ADDRESS = (import.meta.env.VITE_SPLITTER_ADDRESS ??
  DEPLOYED_SPLITTER) as Address

/**
 * `getContent` 的返回。
 *
 * ⚠️ viem 把多返回值的函数解成**元组(按位置)**,不是按名字的对象 ——
 * 所以 `content.data.price` 编译不过。下面的 `toContent` 把位置访问
 * **收在这一处**,其余代码一律用命名字段。
 */
export type Content = {
  creator: Address
  price: bigint
  contentHash: Hex
  recipients: readonly Address[]
  splits: readonly number[]
  active: boolean
}

/** 与 `getContent` 的 outputs 逐位对应。顺序来自 ABI,不要凭记忆写 */
export type RawContent = readonly [
  Address, // creator
  bigint, // price
  Hex, // contentHash
  readonly Address[], // recipients
  readonly number[], // splits
  boolean, // active
]

export function toContent(raw: RawContent): Content {
  const [creator, price, contentHash, recipients, splits, active] = raw
  return { creator, price, contentHash, recipients, splits, active }
}

/**
 * `contentId` 是**前端生成的随机 `bytes32`**(方案 §8.1 调用约定表 + 开发计划 §五 #2 已定稿)。
 *
 * **不派生自标题或时间** —— 派生规则会让 W3(前端)和 W7(Agent)两条路径
 * 对同一个内容算出不同的 id。32 字节随机碰撞概率可忽略,合约另用
 * "重复创建 revert" 兜底唯一性。
 *
 * 用 `crypto.getRandomValues` 而不是 `Math.random()`:后者不是密码学随机源,
 * 而且这里的随机性直接决定 id 是否可被他人猜中并抢先注册。
 */
export function generateContentId(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex
}

/**
 * 校验 URL 里的 `:id` 是不是合法的 contentId,**顺便归一化大小写**。
 *
 * 付费页第一件事就是过这个:不合法的话直接渲染"链接无效",
 * **不能带着一个畸形 id 去读链** —— 那会让 `getContent` revert,
 * 而 revert 的报错信息对买家毫无意义。
 */
export function normalizeContentId(raw: string | undefined): Hex | null {
  if (!raw) return null
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw.toLowerCase() as Hex) : null
}

/** 分享链接 / 二维码用的短形式,只用于显示 */
export function shortContentId(id: Hex, lead = 10, tail = 6): string {
  return `${id.slice(0, 2 + lead)}…${id.slice(-tail)}`
}

/**
 * 付费页要在一个请求里知道的全部内容状态。
 *
 * **为什么要单独定义**:付费页首屏要同时判断"存在 / 已下架 / 我买没买过",
 * 这三个读是独立的,分散在各组件里会各读一遍、各有一套 loading,
 * 首屏就会闪三次骨架屏。
 */
export type ContentGate =
  | { k: 'missing' } // 内容不存在 —— 链接错
  | { k: 'inactive'; content: Content } // 已下架,不再接受新支付
  | { k: 'already-owned'; content: Content } // 买过了 —— 直接给下载入口
  | { k: 'on-sale'; content: Content } // 可以买
