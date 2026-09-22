import type { Hex } from 'viem'
import type { ApiError, ApiErrorCode } from '../../shared/api'
import type { UnlockNonceResponse, UnlockRequest, UnlockResponse } from '../../shared/unlock'
import type { UnlockFailReason, UnlockStep } from './unlockMachine'

/**
 * 解锁的两个端点 —— **前端唯一的服务端调用点**。
 *
 * 单独一个文件(而不是塞进 hook)是为了让"服务端返回什么 → 用户看到什么"
 * 这条映射**可读、可测**。`useUnlockFlow` 只管把它们接到状态机上。
 *
 * ## 为什么错误要在这里就翻译成 `UnlockFailReason`
 *
 * 服务端的 `code` 是**实现细节**(见 `shared/api.ts` 的 10 个值),
 * 而界面要的是"用户该怎么办"。翻译只做一次,放在这一层;
 * 组件拿到的永远已经是"能不能重试"这种可以直接渲染的东西。
 *
 * 原始 `code` 不丢 —— 进 `detail`,界面以小字原样显示,排查时看得到。
 */

/** 带"用户该做什么"的失败。与纯网络错误分开,后者没有 `code` */
export class UnlockError extends Error {
  constructor(
    readonly reason: UnlockFailReason,
    message: string,
    /** 服务端原始的 `code` 与消息,原样保留供显示 */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'UnlockError'
  }
}

/**
 * `ApiErrorCode` → `UnlockFailReason`。
 *
 * ⚠️ 写成 `Record<ApiErrorCode, …>` 而不是 `Partial<...>`,是为了让
 * **服务端新增一个 code 时这里编译报错** —— 否则新 code 会静默落到
 * 兜底分支,而"某个失败原因永远显示成网络繁忙"是最难发现的那种 bug。
 */
export const CODE_TO_REASON: Record<ApiErrorCode, UnlockFailReason | 'step-default'> = {
  // 链上事实:没买
  not_purchased: 'not-purchased',
  // 三个都归"再点一次" —— 对用户来说出路完全一样
  nonce_expired: 'expired',
  nonce_mismatch: 'expired',
  deadline_expired: 'expired',
  // 指向我们自己
  bad_signature: 'signature',
  bad_request: 'protocol',
  // 上游问题 —— 用哪一步来决定措辞(见 describeUnlockFailure)
  upstream_unavailable: 'unavailable',
  not_configured: 'unavailable',
  // 上传那两条在解锁流程里不该出现;真出现了也是"我们这边不对"
  content_claimed: 'protocol',
  content_not_found: 'protocol',
}

/**
 * 发一个请求,并把非 2xx 翻译成 `UnlockError`。
 *
 * ⚠️ 网络层失败(`fetch` 本身 reject)也走这里 —— **必须和 HTTP 错误
 * 一起处理**。不处理的话它会以 `TypeError` 冒到状态机外面,
 * 而状态机只认 `UnlockError`,结果是界面永远停在"正在准备…"。
 */
async function postJson<T>(
  url: string,
  init: RequestInit,
  step: UnlockStep,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    throw new UnlockError('unavailable', '网络请求失败', e instanceof Error ? e.message : undefined)
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null
    const code = body?.error?.code
    if (code && code in CODE_TO_REASON) {
      const mapped = CODE_TO_REASON[code]
      // `step-default` 表示"看这一步是什么再决定" —— 目前没有 code 用它,
      // 留着是为了让上面那张表能表达"这条要按步骤走"这个选项
      const reason: UnlockFailReason = mapped === 'step-default' ? 'unavailable' : mapped
      throw new UnlockError(reason, body?.error?.message ?? '请求被拒绝', `${code} · ${step}`)
    }
    // 不是我们的错误形状(比如 Vercel 平台的 502 页面)—— 当上游问题处理
    throw new UnlockError('unavailable', '服务端返回了意外的响应', `HTTP ${res.status} · ${step}`)
  }

  return (await res.json()) as T
}

/**
 * 取一个一次性 nonce。
 *
 * ⚠️ `contentId` 必须是**已经归一化成小写**的(调用方保证)。
 * 服务端对 contentId 只收小写(见 `shared/storage.ts` 的 `CONTENT_ID_RE`),
 * 而 nonce 在服务端是**按 contentId 绑定**的 —— 大小写不一致会让
 * `POST /api/unlock` 那一步报 `nonce_mismatch`,症状是"刚拿到的凭证就说过期了"。
 */
export async function fetchUnlockNonce(contentId: Hex): Promise<string> {
  const data = await postJson<UnlockNonceResponse>(
    `/api/unlock-nonce?contentId=${encodeURIComponent(contentId)}`,
    { method: 'GET' },
    'nonce',
  )
  return data.nonce
}

/** 拿签名换下载 URL */
export async function postUnlock(wire: UnlockRequest): Promise<UnlockResponse> {
  return postJson<UnlockResponse>(
    '/api/unlock',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    },
    'unlock',
  )
}

/**
 * 把钱包那边抛出来的东西翻译成失败原因。
 *
 * `isUserRejection` 由调用方传入(它在 `lib/payErrors.ts`,与付款流程共用
 * 同一套判断)—— 不在这里 import 是为了让本文件不依赖付款那条链路,
 * 两个流程保持独立。
 */
export function classifyUnlockError(err: unknown, isUserRejection: (e: unknown) => boolean): UnlockError {
  if (err instanceof UnlockError) return err
  if (isUserRejection(err)) return new UnlockError('user-rejected', '用户取消了签名')
  // 走到这里多半是钱包或 viem 抛的异常(chain 不匹配、钱包没实现
  // signTypedData 等)。归到"上游"是因为重试**可能**有用,
  // 而且详情会原样显示出来,排查时看得到真正的原因
  return new UnlockError(
    'unavailable',
    '钱包签名失败',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  )
}
