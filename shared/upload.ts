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
import { type UploadTarget } from './storage.js'

/**
 * 上传授权的签名消息 `Upload` —— **前端签名侧与服务端验签侧共用这一份**。
 *
 * domain 和解析原语在 `shared/eip712.ts`。为什么要共用、为什么要放 `shared/`,
 * 见那个文件的头部说明。
 *
 * ## 这条签名是干嘛的
 *
 * 客户端直传(决策 甲):文件不经过 Function,直接传到 Blob —— 因为
 * **Function 的请求体上限是 4.5 MB**,而内容文件没有尺寸约束。
 * 但直传需要一个写入凭证,方案 §9.1 的原意是"写入凭证不暴露给前端"。
 * 解法是:**服务端签发一个受限 token**(限定 pathname、限定 `put`、短有效期),
 * 而签发之前先要求上传者证明身份 —— 就是这条 `Upload` 签名。
 *
 * ## 为什么签名里有 `targets`
 *
 * `targets`(内容 / 预览图)决定了这份文件**落到哪个 store** ——
 * `content/` 是私有、`preview/` 是公开 CDN。如果它不进签名,
 * 一条为"上传预览图"签发的授权就能被拿去传 `content/` 那条路径,
 * 于是**付费内容被写进公开 store,变成人人可读**。
 *
 * 换句话说:一条签名应该只够干一件事。这跟方案 §四 对受限 token 的要求
 * ("签一个宽松的 token 等于把 store 的写权限发出去了")是同一个道理,
 * 只不过这里收紧的是签名本身。
 *
 * ## ⚠️ 2026-09-25:单个 `target: string` → `targets: string[]`
 *
 * 起因是发布要同时往两个 store 写(内容 + 派生出来的预览图),而**每个
 * `target` 都要一次独立签名** ⇒ 发布时的钱包弹窗从 2 次变 3 次。
 * 改成**在签名里逐一列举**允许的 store,一次签名覆盖两者。
 *
 * ⚠️ **这确实放松了上面那条"一条签名只够干一件事"**,如实记下代价:
 * 签名里说 `['content','preview']` 的人,也同时授权了往公开 store 写
 * `preview/<contentId>`。危害是有界的 —— 签名同时钉死了 `uploader`,
 * 所以能写公开路径的**只有创作者本人**;而"把付费内容传到公开路径"
 * 只有客户端自己干得出来(那等于自己泄自己的货,不构成新攻击面)。
 * 仍然不许的是:让**没有出现在数组里**的 store 被写到。
 *
 * ⚠️ **数组的顺序与内容都是签名的一部分。** 服务端 `parseUploadAuth` 只做
 * **逐元素合法性校验**,绝不排序、去重或改写 —— 动一下验签就会**静默失败**
 * (报错只说"签名不符",看不出是数组被动过)。
 *
 * ## 为什么**没有** nonce(2026-09-23 定)
 *
 * 解锁那条签名有 nonce,这条没有,是权衡后的结果而不是漏掉:
 *
 * - nonce 防的是**重放**。而重放这条签名的唯一后果,是拿到一张指向
 *   **同一条 pathname** 的 token —— 而那个 blob 已经存在了,
 *   平台侧 `allowOverwrite` **默认 false** 会直接拒掉(见 `shared/storage.ts`)。
 *   也就是说重放**造成不了任何后果**,nonce 买不到额外的安全。
 * - 所以这里只靠 `deadline` 兜底,并且**不给 `/api/unlock-nonce` 增加第二种用途**
 *   —— 那个端点的名字保持不变,含义也不变。
 *
 * 这个取舍写进了方案 §20 的诚实边界。
 */

/**
 * EIP-712 类型定义。
 *
 * ⚠️ **字段顺序是签名的一部分,不要重排。** 打乱顺序不会报错,
 * 只会让所有签名静默失效。
 *
 * 元素用 `string` 而不是 `uint8` 枚举:方案 §9.2 选 EIP-712 而不是
 * `personal_sign` 的**首要理由就是"钱包里显示什么"** —— 用户看到
 * `targets: ["content", "preview"]` 能明白自己在授权哪几个位置,看到 `[1, 2]` 不能。
 */
export const UPLOAD_TYPES = {
  Upload: [
    { name: 'contentId', type: 'bytes32' },
    { name: 'targets', type: 'string[]' },
    { name: 'uploader', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/**
 * 前端把 `deadline` 设在多久之后(秒)。
 *
 * 比解锁那条更宽松没有意义 —— 签完立刻就传,5 分钟只多不少。
 * 与 `UNLOCK_DEADLINE_SECONDS` 取同一个值是为了少一个"为什么这两个不一样"
 * 的问题,不是因为它们有共同的机制。
 */
export const UPLOAD_DEADLINE_SECONDS = 5 * 60

/** 两个合法的 `target` 取值 */
const UPLOAD_TARGETS: readonly UploadTarget[] = ['content', 'preview']

/** 运行时判断一个字符串是不是合法 `target` */
export function isUploadTarget(value: string): value is UploadTarget {
  return (UPLOAD_TARGETS as readonly string[]).includes(value)
}

/** 签名消息的"计算形态" —— 值是真 bigint,直接喂给 viem 签/验 */
export type UploadMessage = {
  contentId: Hex
  /** 允许落到哪几个 store —— 见上面"为什么签名里有 targets"。⚠️ **顺序即签名的一部分** */
  targets: readonly UploadTarget[]
  uploader: Address
  /** unix 秒。注意是**秒**不是毫秒 */
  deadline: bigint
}

/**
 * 签名消息的"传输形态" —— 值全是字符串,能直接进 JSON。
 * 理由同 `shared/unlock.ts` 的同名类型:**JSON 装不下 bigint**。
 */
export type UploadAuthWire = {
  contentId: string
  /**
   * ⚠️ 这里**不是** `string[]`,而是**逐元素收窄过的** `UploadTarget[]` ——
   * 与同一条 wire 上其余字段的处理方式不同,是有意的:
   *
   * `contentId` / `uploader` / `deadline` 的形状校验交给下游各自那道门
   * (`uploadPathname` 只收小写、比较地址时先小写、`toUploadMessage` 再解一次),
   * 所以它们的类型停在"一个字符串"。但 `targets` 只有 `isUploadTarget` 这一道门,
   * 而它直接决定**这份文件落哪个 store** —— 落错了就是把付费内容写进公开 store。
   *
   * 所以 `parseUploadAuth` 验过之后,类型上就如实收窄成 `UploadTarget[]`,
   * 让**每一个**拿到 `auth.targets` 的地方都自动是安全的,而不是各自记得再判一次。
   * 类型在这里不是装饰,它是"只有一处能决定去哪个 store"这条纪律的载体。
   */
  targets: readonly UploadTarget[]
  uploader: string
  deadline: string
  signature: string
}

/**
 * 组装 viem 要的完整 typed data。
 * 签名侧 `walletClient.signTypedData(uploadTypedData(msg))`,
 * 验签侧 `verifyTypedData({ ...uploadTypedData(msg), address, signature })`。
 */
export function uploadTypedData(
  message: UploadMessage,
  verifyingContract: Address = DEPLOYED_SPLITTER,
) {
  return {
    domain: splitJarDomain(verifyingContract),
    types: UPLOAD_TYPES,
    primaryType: 'Upload',
    message,
  } as const
}

/**
 * 上传授权的**结构校验** —— 只判"形状对不对",不判"语义对不对"。
 *
 * 语义(deadline 过没过期、签名对不对、链上该内容是不是这个人的)归路由管。
 *
 * ⚠️ 服务端**必须先过这一关再碰密码学**。返回 `null` 就是"这不是一个合法请求"。
 */
export function parseUploadAuth(raw: unknown): UploadAuthWire | null {
  // ⚠️ `targets` **不在这个列表里** —— `parseStringFields` 只认字符串字段,
  // 数组过不去,所以它单独校验(见下)。
  const fields = parseStringFields(raw, ['contentId', 'uploader', 'deadline', 'signature'])
  if (!fields) return null

  const { contentId, uploader, deadline, signature } = fields
  if (!isBytes32(contentId)) return null
  if (!isAddress(uploader)) return null
  if (!isStandardSignature(signature)) return null
  if (parseUint256(deadline) === null) return null

  /**
   * ⚠️⚠️ **只校验,绝不改写这个数组。**
   *
   * 它整个是签名覆盖的消息的一部分 —— 排一次序、去一次重、换成 `Set`,
   * 都会让服务端算出的 digest 与用户签的那个不一样,于是**验签静默失败**
   * (错误只说"签名与上传者地址不符",看不出是数组被动过手脚)。
   * 所以下面新建的那个数组里,**元素与顺序必须与原数组逐项相同**。
   *
   * 空数组直接拒:它一个 store 都没授权,是畸形输入而不是"什么都不许"。
   */
  const rawTargets = (raw as { targets?: unknown }).targets
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return null
  const targets: UploadTarget[] = []
  for (const t of rawTargets) {
    if (typeof t !== 'string' || !isUploadTarget(t)) return null
    targets.push(t)
  }

  // 地址归一化成 checksum 形态 —— 理由与 `parseUnlockWire` 完全相同:
  // 下游要拿它做**大小写敏感的字符串比较**(比对恢复出的地址、比对 KV 里的归属),
  // 不归一化的话一个全小写的地址会把"同一个人"判成"另一个人"。
  // ⚠️ 用**非 strict** 的 `isAddress` —— viem 的 `strict: true` 是校验 checksum,
  // 会拒掉合法的小写地址。
  return {
    contentId,
    targets,
    uploader: getAddress(uploader.toLowerCase() as Address),
    deadline,
    signature,
  }
}

/**
 * 这条授权**允不允许**写某个 store。
 *
 * 服务端唯一该用的判断就是这个 —— 别处自己写 `auth.targets.includes(...)`
 * 会让"哪些 store 被授权"这件事出现第二个定义处。
 *
 * ⚠️ 它**只回答"允不允许"**,不回答"该不该":`content-meta` 那条端点额外
 * 要求授权里**必须含 `content`**(标题是内容自身的属性,和预览图无关)。
 */
export function allowsUploadTarget(
  auth: Pick<UploadAuthWire, 'targets'>,
  target: UploadTarget,
): boolean {
  return auth.targets.includes(target)
}

/** 传输形态 → 计算形态。只对已通过 `parseUploadAuth` 的值用 */
export function toUploadMessage(wire: UploadAuthWire): UploadMessage {
  const deadline = parseUint256(wire.deadline)
  // ⚠️ 运行时再验一遍 `targets` 而不是信类型:这个函数的入参在类型上已经是
  // `UploadTarget[]`,但**从网络反序列化出来的对象不经过类型系统**。
  // 它同时守住"空数组"这个畸形输入(空数组等于什么都不许,不该算合法授权)
  if (
    deadline === null ||
    !Array.isArray(wire.targets) ||
    wire.targets.length === 0 ||
    !wire.targets.every((t) => isUploadTarget(t))
  ) {
    throw new Error('toUploadMessage: 未经 parseUploadAuth 校验的输入')
  }
  return {
    contentId: wire.contentId as Hex,
    // ⚠️ 原样传引用,不复制、不排序 —— 见 `parseUploadAuth` 里那段
    targets: wire.targets,
    uploader: wire.uploader as Address,
    deadline,
  }
}

/** 计算形态 → 传输形态(签名侧用) */
export function fromUploadMessage(message: UploadMessage, signature: Hex): UploadAuthWire {
  return {
    contentId: message.contentId,
    targets: message.targets,
    uploader: message.uploader,
    deadline: message.deadline.toString(),
    signature,
  }
}

/** 前端的 deadline 取值。单位是**秒**,`Date.now()` 是**毫秒**,这里显式除 */
export function nextUploadDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + UPLOAD_DEADLINE_SECONDS)
}

/**
 * 把授权编码成 `clientPayload` —— 也就是 `upload()` 那个"顺带捎给服务端的字符串"。
 *
 * ## 为什么走 clientPayload 而不是自己拼请求体
 *
 * `@vercel/blob` 客户端调 `handleUpload` 路由时,请求体是**它自己定的格式**
 * (里面带 pathname、contentType、multipart 等),我们没法往里加字段。
 * 它留的扩展点就是 `clientPayload`。所以授权信息从这里进,
 * 服务端在 `onBeforeGenerateToken(pathname, clientPayload)` 的第二参里拿到。
 *
 * ## ⚠️ 它**只是搬运**,不是信任边界
 *
 * 服务端拿到的这个字符串**未经任何验证** —— 它由客户端完全控制。
 * 真正的信任来自里面的签名(服务端会自己验),以及服务端**用 pathname
 * 重新算一遍**再比对(见 `shared/storage.ts` 的 `uploadPathname`)。
 * 别因为"它经过了服务端"就把它当可信输入。
 */
export function encodeUploadClientPayload(wire: UploadAuthWire): string {
  return JSON.stringify(wire)
}

/**
 * 解析 `clientPayload`。坏 JSON、缺字段、形状不对一律返回 `null`。
 *
 * `JSON.parse` 对畸形输入是**抛异常**的,而这里在处理客户端完全可控的字符串 ——
 * 不包起来就等于"发一段坏 JSON 换一个 500"。理由同 `shared/eip712.ts`
 * 的解析原语:失败路径必须是返回值。
 */
export function decodeUploadClientPayload(raw: string | null): UploadAuthWire | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return parseUploadAuth(parsed)
}
