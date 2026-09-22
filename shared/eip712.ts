import type { Address, Hex } from 'viem'
import { isHex } from 'viem'
import { CHAIN, DEPLOYED_SPLITTER } from './chain.js'

/**
 * SplitJar 的 **EIP-712 domain** 与几个签名消息共用的解析原语 ——
 * **前端签名侧与服务端验签侧共用这一份**。
 *
 * ## 为什么单独一个文件
 *
 * 本项目有**两种**签名消息(解锁门禁的 `Unlock`、上传授权的 `Upload`),
 * 但它们**必须共用同一个 domain**。把 domain 放在其中一个消息文件里、
 * 让另一个去 import,功能上没错,但那个文件的名字会开始骗人 ——
 * 后来人看到 "upload 引用了 unlock 的 domain",第一反应是"这是不是写错了",
 * 而不是"这是刻意的"。所以 domain 有它自己的位置。
 *
 * ## 为什么必须共用,而不是两边各写一遍(方案 §9.2)
 *
 * EIP-712 有个很不好受的特性:**签名和验签只要有一个字段对不上,结果就是
 * "签名永远验不过"**,而且报错极不含糊 —— 看不出是哪个字段错了。最容易错的
 * 就是这两处:
 *
 *   ① **domain 用错。** 本项目里**同时存在两套 EIP-712 domain**:
 *      USDC 的(Circle 定义,Agent 路径的 ERC-3009 `TransferWithAuthorization` 用)
 *      和我们的(SplitJar)。任何一侧引用了错的那套,就是永久验不过。
 *   ② **类型定义漂移。** EIP-712 的 `encodeType` **和字段顺序有关**——
 *      前端按一种字段顺序签、服务端按另一种验,同样验不过。
 *
 * ⚠️ 已实测(2026-09-23):拿 USDC 的 domain 去验一条按 SplitJar domain
 * 签出来的 `Unlock`,结果必然是 `false`。这不是推测,是跑出来的。
 *
 * ⚠️ 本文件**两端共用**,所以不许出现 `import.meta`(Node 里没有),
 * 也不许出现 `process.env`(浏览器里没有)。地址由调用方传进来:
 * 前端读 `VITE_SPLITTER_ADDRESS`、服务端读 `serverEnv('SPLITTER_ADDRESS')`,
 * 两边缺省都回落 `DEPLOYED_SPLITTER`(写法见 `shared/chain.ts` 顶部注释)。
 */

/** domain 的 `name` —— 会在钱包里显示给用户看,所以别改成无意义的值 */
export const SPLITJAR_DOMAIN_NAME = 'SplitJar'

/** domain 的 `version` —— 改动签名形状时必须一起升,否则新旧签名会互相冒充 */
export const SPLITJAR_DOMAIN_VERSION = '1'

/**
 * 构造 EIP-712 domain。
 *
 * ⚠️ `verifyingContract` 填**已部署的 `CreatorSplitter`**,不是 `0x0`
 * (方案 §9.2)。填 `0x0` 会让同一个签名在别的应用里也能用 ——
 * 那就等于没有应用绑定。
 *
 * 默认值取 `DEPLOYED_SPLITTER` 是有意的:**两侧都不覆盖时必然一致**。
 * 只有在真的换了合约地址时才传参,而且**必须两端同时换**——
 * 只换一侧的症状就是"签名永远验不过"。
 */
export function splitJarDomain(verifyingContract: Address = DEPLOYED_SPLITTER) {
  return {
    name: SPLITJAR_DOMAIN_NAME,
    version: SPLITJAR_DOMAIN_VERSION,
    chainId: CHAIN.id,
    verifyingContract,
  } as const
}

/** 本部署的 domain(用 `DEPLOYED_SPLITTER`)—— 需要现成常量时的入口 */
export const SPLITJAR_DOMAIN = splitJarDomain()

/* ────────────────────────────── 解析原语 ──────────────────────────────
 *
 * 下面四个是两种消息的请求体校验都要用的东西。它们**全部返回 null 而不抛异常**
 * —— 这不是风格问题:在一个 HTTP 路由里,未捕获的异常就是 500,
 * 而那等于给了任何访客一个"用几个字节换一次 500"的口子。
 * 输入校验的失败路径必须是返回值。
 */

/**
 * uint256 的十进制解析。
 *
 * 为什么不用 `BigInt(s)`:它会对畸形输入抛 `SyntaxError`(见上面的理由)。
 *
 * 正则同时保证了**规范形式**:不接受前导零(`01`)、不接受负号、不接受小数、
 * 不接受科学计数法。上限按 uint256 的字面量上界卡
 * (`2**256 - 1` 是 78 位十进制),防止构造超长字符串去撑爆解析。
 */
const UINT256_MAX = 2n ** 256n - 1n

export function parseUint256(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= UINT256_MAX ? parsed : null
}

/** 传过来的值是不是一个 32 字节的 hex —— `contentId` 的形状 */
export function isBytes32(value: string): value is Hex {
  return isHex(value, { strict: true }) && value.length === 66
}

/**
 * 传过来的值是不是一条**标准 65 字节 ECDSA 签名**(`r` 32 + `s` 32 + `v` 1)。
 *
 * 为什么长度也要在这里卡:不卡的话畸形签名会一路走到
 * `recoverTypedDataAddress()` **抛异常**,而路由里未捕获的异常就是 500。
 *
 * (`signTypedData` 产出的就是 65 字节,所以这个限制不会误伤真实客户端。
 * 刻意**不支持** 64 字节的 compact 签名 —— 本项目的签名方只有我们自己的前端。)
 */
export function isStandardSignature(value: string): value is Hex {
  return isHex(value, { strict: true }) && value.length === 132
}

/**
 * 把 `raw` 当对象读,并要求列出的每一个字段都是**字符串**。
 *
 * 两个消息的请求体解析开头都长一个样(判对象、逐字段判 `typeof`),这里收成一处。
 * 任何一项不满足就返回 `null`。
 *
 * ⚠️ 它只保证"这些字段是字符串",**不保证它们的形状**(是不是 hex、
 * 是不是合法地址、有没有超 uint256)—— 那些归各自的 `parse*Wire` 管。
 */
export function parseStringFields<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Record<K, string> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const out = {} as Record<K, string>
  for (const key of keys) {
    const value = source[key]
    if (typeof value !== 'string') return null
    out[key] = value
  }
  return out
}
