/**
 * HTTP 响应的共用形状 —— **前端要按 `code` 分支,所以它住在 `shared/`**。
 *
 * 原本这个文件在 `server/`(那时只有服务端用它)。W5 加了下载按钮之后,
 * 前端必须能区分这几类失败,因为**用户该做的事完全不同**:
 *
 *   - `not_purchased`   → "先去买" / "等节点追上来"
 *   - `nonce_expired`   → "重新点一次下载" —— 重试即可
 *   - `deadline_expired`→ 同上(本机时钟偏了也会走到这)
 *   - `upstream_unavailable` → 重试没有意义,是我们这边的问题
 *
 * 只靠状态码做不到:上面几种大多都会是 401/403。所以状态码给"大类",
 * `code` 给"具体是哪一种"。
 *
 * ⚠️ **这就是 `shared/chain.ts` 那个规矩的又一例**:两端必须一致的常量
 * 放 `shared/`,让它成为结构上的事实,而不是靠两边各写一份、靠人记得同步。
 * 前端拿它做 `switch`,`src/lib/unlockMachine.ts` 的 `UnlockFailReason`
 * 是它的**语义映射**(而不是直接复用 —— 前端的失败集合还包含"用户拒签"
 * 这类根本没到服务端的原因)。
 *
 * ## ⚠️ 错误消息一律是**固定的短句**,不回显任何输入
 *
 * 这个接口是公开的。把用户输入拼进错误消息(比如"contentId 0x… 不合法")
 * 就是把一个反射点白送出去 —— JSON 响应本身不构成 XSS,但没必要留这个习惯。
 *
 * ⚠️ 本文件两端共用,所以不许出现 `process.env`(浏览器里没有)
 * 也不许出现 `import.meta`(Node 里没有)。
 */

/** 前端可以分支的失败原因。新增时必须同步前端 */
export type ApiErrorCode =
  /** 请求本身不成形(缺字段、形状不对) */
  | 'bad_request'
  /** 签名验不过 —— 也可能是 body 被改过 */
  | 'bad_signature'
  /** 签名里的 deadline 已过 */
  | 'deadline_expired'
  /** nonce 不存在 / 已过期 / 已被用掉 */
  | 'nonce_expired'
  /** nonce 是给**另一个** contentId 签发的 */
  | 'nonce_mismatch'
  /** 链上确认:这个地址没买过这份内容 */
  | 'not_purchased'
  /** 内容不存在(还没注册) */
  | 'content_not_found'
  /** 这个 contentId 已经被别的人认领了 */
  | 'content_claimed'
  /** 上游(KV / RPC / Blob)不可用 —— 我们这边的问题 */
  | 'upstream_unavailable'
  /** 服务端环境变量没配齐 */
  | 'not_configured'
  // ── W7 · Agent 路径(方案 §9.4)新增 ────────────────────────────────
  /** 报价验签不过 —— 字段被改过,或不是我们签发的 */
  | 'quote_invalid'
  /** 报价本身过期了(与上面那条分开:一个是伪造,一个是超时) */
  | 'quote_expired'
  /** 链上没有这笔交易,或它的收据是失败的 */
  | 'payment_not_found'
  /** 收据里的 contentId / payer 与请求声明的不符 —— 含冒用他人交易 */
  | 'payment_mismatch'
  /** 这个 txHash 已经被消费过了(防重放) */
  | 'payment_replayed'
  /**
   * 内容已下架。
   *
   * ⚠️ 与 `not_purchased` 的 402 **不是一回事,别合并**:402 是"可以买,先付钱",
   * 而这个**不能买** —— 合约 `pay()` 第三行就 `revert ContentInactive`,
   * 对已下架的内容回 402 等于邀请 agent 花 gas 换一次必然的 revert。
   * 人类付费页早就堵上了这条路(`src/lib/payGate.ts` 的 `content-inactive`),
   * 服务端不能反而敞开。
   */
  | 'content_inactive'

/** 一条错误响应 */
export type ApiError = {
  error: {
    code: ApiErrorCode
    message: string
  }
}

/**
 * 造一条错误响应。
 *
 * `message` 是给**人看的兜底文案**,前端应当优先按 `code` 决定行为 ——
 * 因为文案会改,`code` 不会。
 */
export function errorResponse(status: number, code: ApiErrorCode, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, { status })
}
