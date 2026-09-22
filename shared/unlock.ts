import type { Address, Hex } from 'viem'
import { getAddress, isAddress } from 'viem'
import { DEPLOYED_SPLITTER } from './chain.js'
import {
  isBytes32,
  isStandardSignature,
  parseStringFields,
  parseUint256,
  splitJarDomain,
} from './eip712.js'

/**
 * 付费门禁的签名消息 `Unlock` —— **前端签名侧与服务端验签侧共用这一份**。
 *
 * domain 和解析原语在 `shared/eip712.ts`(两个签名消息共用),这里只管
 * `Unlock` 自己的形状。为什么不各写一份、为什么要放 `shared/`,见那个文件的
 * 头部说明 —— 一句话:**EIP-712 只要有一个字段对不上,症状就是"签名永远
 * 验不过",而且报错看不出是哪里错了**,所以"两端一致"不能靠人记得同步。
 */

/**
 * EIP-712 类型定义。
 *
 * ⚠️ **字段顺序是签名的一部分,不要重排。** 打乱顺序不会报错,
 * 只会让所有签名静默失效。
 *
 * ⚠️ `buyer` 明明能从签名里恢复出来,**但仍然显式入签**(方案 §9.2 已定):
 * 一是钱包会把地址显示给用户看(可读性),二是服务端多一层断言 ——
 * 要求"恢复出的地址 == `buyer` 字段",而不是直接用恢复出的地址去查链。
 */
export const UNLOCK_TYPES = {
  Unlock: [
    { name: 'contentId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/**
 * nonce 在服务端的存活时间(秒)。
 *
 * 这是"从签发到签名送达"的窗口,不是"用户思考多久"。
 * 方案 §9.2 定的是 5 分钟 —— 够慢的网络走完一个来回,又不至于长到能被盯着抢。
 */
export const NONCE_TTL_SECONDS = 5 * 60

/**
 * 签出来的下载 URL 的有效期(秒)。
 *
 * 方案 §9.1 写死 60s,**不能延长**:链接一旦外流就等于内容泄露,
 * 短时效是"外流了也基本没用"这个性质的唯一来源。
 * 演示时过期了就让用户重新点一次下载 —— 这比"自动续期"更能说明门禁是真的。
 */
export const UNLOCK_URL_TTL_SECONDS = 60

/**
 * 前端把 `deadline` 设在多久之后(秒)。
 *
 * 与 `NONCE_TTL_SECONDS` 同为 300 是刻意的**双保险**(方案 §9.2):
 * nonce 管"用过没有",deadline 管"什么时候之前有效"。
 * 两者互相独立 —— 即使 KV 整个丢了,过期的签名也仍然签不动。
 */
export const UNLOCK_DEADLINE_SECONDS = 5 * 60

/** 签名消息的"计算形态" —— 值是真 bigint,直接喂给 viem 签/验 */
export type UnlockMessage = {
  contentId: Hex
  buyer: Address
  /** uint256。KV 里的一次性 nonce,由 `GET /api/unlock-nonce` 签发 */
  nonce: bigint
  /** unix 秒。注意是**秒**不是毫秒 —— 混用会让签名要么早已过期要么永不失效 */
  deadline: bigint
}

/**
 * 签名消息的"传输形态" —— 值全是字符串,能直接进 JSON。
 *
 * 为什么不直接传 `UnlockMessage`:**JSON 装不下 bigint**。
 * `JSON.stringify(1n)` 当场抛 `TypeError`,而 `JSON.parse` 也变不出 bigint。
 * 所以线上格式一律字符串,**在两端各自显式转换**(转换只走下面的
 * `toUnlockMessage` / `fromUnlockMessage`,别手写)。
 */
export type UnlockWire = {
  contentId: string
  buyer: string
  nonce: string
  deadline: string
  signature: string
}

/** `POST /api/unlock` 的请求体 */
export type UnlockRequest = UnlockWire

/** `POST /api/unlock` 的响应体 */
export type UnlockResponse = {
  /** 短时效签名 URL */
  url: string
  /** 从签发时刻算起的有效秒数 —— 前端据此显示倒计时,不要自己猜 */
  expiresInSeconds: number
}

/** `GET /api/unlock-nonce` 的响应体 */
export type UnlockNonceResponse = {
  nonce: string
  expiresInSeconds: number
}

/**
 * 组装 viem 要的完整 typed data。
 *
 * 签名侧用法:`walletClient.signTypedData(unlockTypedData(msg))`
 * 验签侧用法:`verifyTypedData({ ...unlockTypedData(msg), address, signature })`
 * —— **同一个函数**,所以两侧的 domain 和 types 在结构上不可能不一致。
 */
export function unlockTypedData(
  message: UnlockMessage,
  verifyingContract: Address = DEPLOYED_SPLITTER,
) {
  return {
    domain: splitJarDomain(verifyingContract),
    types: UNLOCK_TYPES,
    primaryType: 'Unlock',
    message,
  } as const
}

/**
 * 请求体的**结构校验** —— 只判"形状对不对",不判"语义对不对"。
 *
 * 语义(deadline 过没过期、nonce 在不在、链上买没买)一律归路由管,
 * 因为那些需要 KV 和链,不该混进这个纯函数里。
 *
 * ⚠️ 服务端**必须先过这一关再碰密码学和链**。畸形输入不能让路由抛异常。
 * 返回 `null` 就是"这不是一个合法请求"。
 */
export function parseUnlockWire(raw: unknown): UnlockWire | null {
  const fields = parseStringFields(raw, ['contentId', 'buyer', 'nonce', 'deadline', 'signature'])
  if (!fields) return null

  const { contentId, buyer, nonce, deadline, signature } = fields
  if (!isBytes32(contentId)) return null
  if (!isAddress(buyer)) return null
  if (!isStandardSignature(signature)) return null
  if (parseUint256(nonce) === null) return null
  if (parseUint256(deadline) === null) return null

  // 地址**归一化成 checksum 形态**再往下走。
  // 这一步是必须的:下游要拿它去比对"恢复出的地址"、以及当链上 `purchases`
  // 的下标,而字符串比较是大小写敏感的 —— 不归一化的话,一个全小写的地址
  // 会让"已购买"判成"没买"。EIP-712 对 address 只编码 20 个字节,所以
  // 归一化**不影响验签**(已实测)。
  //
  // ⚠️ 注意用**非 strict** 的 `isAddress`:viem 的 `{ strict: true }` 是
  // "校验 checksum",那会拒掉合法的小写地址 —— 而小写是完全合法的输入。
  return { contentId, buyer: getAddress(buyer.toLowerCase() as Address), nonce, deadline, signature }
}

/** 传输形态 → 计算形态。只对已通过 `parseUnlockWire` 的值用 */
export function toUnlockMessage(wire: UnlockWire): UnlockMessage {
  const nonce = parseUint256(wire.nonce)
  const deadline = parseUint256(wire.deadline)
  // parseUnlockWire 已经卡过,这里只是把"不可能"写成显式失败,
  // 免得将来有人绕过 parseUnlockWire 直接调本函数时静默传个 0n 进去
  if (nonce === null || deadline === null) {
    throw new Error('toUnlockMessage: 未经 parseUnlockWire 校验的输入')
  }
  return {
    contentId: wire.contentId as Hex,
    buyer: wire.buyer as Address,
    nonce,
    deadline,
  }
}

/** 计算形态 → 传输形态(签名侧用) */
export function fromUnlockMessage(message: UnlockMessage, signature: Hex): UnlockWire {
  return {
    contentId: message.contentId,
    buyer: message.buyer,
    nonce: message.nonce.toString(),
    deadline: message.deadline.toString(),
    signature,
  }
}

/**
 * 前端的 deadline 取值 —— 从"现在"往后 `UNLOCK_DEADLINE_SECONDS` 秒。
 *
 * 单位是**秒**,`Date.now()` 是**毫秒**,这里显式除。混用是本项目里
 * 最容易犯又最难发现的一类错:毫秒当秒用会得到一个"几万年后才过期"的签名,
 * 门禁看起来正常但形同虚设。
 */
export function nextUnlockDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + UNLOCK_DEADLINE_SECONDS)
}
