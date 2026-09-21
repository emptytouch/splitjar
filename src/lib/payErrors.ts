import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  TimeoutError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem'
import type { FailReason, Step } from './payMachine'

/**
 * 把 viem / wagmi 抛出来的各种错误,收敛成状态机认识的那几个 `FailReason`。
 *
 * ## 为什么必须单独一个文件
 *
 * 上游的要求是「**每一种失败都必须映射到一个明确的界面状态**」。
 * 而 viem 的错误是一棵树(`BaseError` 套 `cause`),加上钱包注入层的
 * provider 错误码,直接 `catch (e) { setError(e.message) }` 的结果就是
 * 用户看到一屏英文堆栈 —— 那正是"不能都落到'处理中'然后卡死"要防的东西,
 * 只不过换成了"都落到一段看不懂的报错"。
 *
 * 所以这个文件是**错误 → 语义**的唯一翻译层,和 `payMachine` 的
 * `describeFailure` 配套:`payErrors` 给出"是什么",`describeFailure` 给出"怎么办"。
 */

/**
 * `BaseError.walk` 的作用:viem 会把原始错误包好几层
 * (`ContractFunctionExecutionError` → `ContractFunctionRevertedError` → …)。
 * 直接 `instanceof` 判最外层永远判不中,必须沿 `cause` 链走。
 */
function find<T>(err: unknown, ctor: abstract new (...args: never[]) => T): T | null {
  if (!(err instanceof BaseError)) return null
  return err.walk((e) => e instanceof ctor) as T | null
}

/**
 * 用户在钱包里点了"拒绝",或者直接关了弹窗。
 *
 * 注意:**这不是错误**,是用户的正常选择。调用方必须用中性的文案
 * (见 `describeFailure` 里的 `user-rejected`),别用报错的语气吓人。
 */
export function isUserRejection(err: unknown): boolean {
  if (find(err, UserRejectedRequestError)) return true

  // 注入式钱包(EIP-1193)在这一层不一定被 viem 包成 UserRejectedRequestError,
  // 常见的是裸的 { code: 4001 }。两个都认,否则会掉进 unclassified 里
  const code = (err as { code?: number })?.code
  if (code === 4001) return true

  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  return msg.includes('user rejected') || msg.includes('user denied')
}

/**
 * 合约里的自定义错误。
 *
 * ABI 里那 14 个 error(`AlreadyPurchased` / `ContentInactive` / …)都从这里出来。
 * 拿到 `errorName` 就能精确映射,不用去猜 revert 字符串。
 */
export function contractErrorName(err: unknown): string | null {
  const reverted = find(err, ContractFunctionRevertedError)
  return reverted?.data?.errorName ?? null
}

/**
 * 主分类器。
 *
 * `phase` 决定 `insufficient-allowance` 的判断 —— 只有到第 2 笔(pay)才可能
 * 因为授权不够而失败;第 1 笔本身就是授权,报"授权不足"没有意义。
 */
export function classifyError(err: unknown, phase: Step = 2): FailReason {
  // ① 用户主动取消 —— 优先级最高,它可能同时满足别的判据
  if (isUserRejection(err)) return 'user-rejected'

  // ② 合约自定义错误 —— 精确,优先于下面所有猜测
  const name = contractErrorName(err)
  if (name) {
    switch (name) {
      case 'AlreadyPurchased':
        return 'already-purchased'
      case 'ContentInactive':
        return 'content-inactive'
      case 'ContentNotFound':
        return 'content-not-found'
      case 'InsufficientAllowance':
        return 'insufficient-allowance'
      case 'PaymentFailed': // 合约里 USDC transferFrom 失败 —— 十有八九是余额或授权
        return phase === 1 ? 'insufficient-usdc' : 'insufficient-allowance'
      default:
        return 'reverted'
    }
  }

  // ③ 回执阶段超时 —— **必须**与网络超时区分开,处理方式完全不同。
  //    见 payMachine.ts 的 RECEIPT_TIMEOUT_NOTE:这个不能给一键重试
  if (find(err, WaitForTransactionReceiptTimeoutError)) return 'receipt-timeout'

  // ④ gas 不够(注意:是 AVAX 不够付 gas,不是 USDC 不够付款)
  if (find(err, InsufficientFundsError)) return 'insufficient-avax'

  // ⑤ 网络层
  if (find(err, TimeoutError) || find(err, HttpRequestError)) return 'rpc-timeout'

  // ⑥ 兜底。**不猜** —— 猜成"余额不足"会让用户跑去领币,
  //    而真实原因可能是完全别的东西。诚实地说"合约拒绝了,可以重试"
  return 'reverted'
}

/**
 * 从错误里挖出**代币合约自己**那句 revert 文案。
 *
 * ## 为什么需要它(2026-09-22 实测推翻了此前的假设)
 *
 * 一直以为"收款方拒收"会走到 `CreatorSplitter` 的 `WithdrawFailed` ——
 * 即 `usdc.transfer()` **返回 false**。在 fork 上用真实 Fuji USDC 试了一遍:
 *
 *   ```
 *   cast call <splitter> "withdraw()" --from <被拉黑的地址>
 *   → execution reverted: Blacklistable: account is blacklisted
 *     0x08c379a0…  ← Error(string),不是任何自定义 error
 *   ```
 *
 * 原因:`FiatTokenV2.transfer` 带 `notBlacklisted` **修饰符**,拉黑的地址
 * 在 modifier 里就 `require` 挂了 —— **根本走不到返回 false 那一步**。
 * 所以 `WithdrawFailed` 在这个场景下永远不会被触发。
 *
 * 后果很严重:`contractErrorName()` 返回 null → 分类器落到 `reverted`
 * → 界面说"**交易被合约拒绝,可以重试**"。而重试一百次结果一样,
 * 用户会一直在那儿点。这条文案必须由**代币侧的真实 revert 字符串**来判。
 *
 * ⚠️ 匹配的是 Circle `FiatToken` 自己的措辞(`Blacklistable: account is
 * blacklisted` / `Pausable: paused`),2018 年至今没变过。这是**专门为
 * 我们唯一支持的那个代币**写的,不是通用 revert 解析。
 *
 * ## 为什么要退回到 message 文本
 *
 * 真钱包里 viem 会把 revert 解成 `ContractFunctionRevertedError`,
 * 从 `data.args` 就能拿到。但注入式钱包(EIP-1193)那一层有时只抛一个
 * 裸的 `Error("…execution reverted: Blacklistable…")`,viem 包不成
 * 那个类型 —— 我们 fork 上的 mock 钱包就是这样。两条路都走,才不至于
 * "在模拟器上验通过、到真钱包又变回重试文案"。
 */
export function revertText(err: unknown): string | undefined {
  const parts: string[] = []

  const reverted = find(err, ContractFunctionRevertedError)
  if (reverted) {
    // `Error(string)` 会被解成 errorName === 'Error'、args[0] === 那句文案
    const args = reverted.data?.args
    if (Array.isArray(args) && typeof args[0] === 'string') parts.push(args[0])
    if (reverted.reason) parts.push(reverted.reason)
  }

  // 注入式钱包那条路:revert 就藏在 message 里
  if (err instanceof Error && err.message) parts.push(err.message)
  const cause = (err as { cause?: unknown })?.cause
  if (cause instanceof Error && cause.message) parts.push(cause.message)

  return parts.length ? parts.join(' | ') : undefined
}

/**
 * 给 `reverted` 用:从原始错误里挖一句能给人看的原因。
 *
 * 只用于**附加说明**,不参与分类。挖不到就返回 undefined ——
 * 界面在没有它时也要能正常工作。
 */
export function shortReason(err: unknown): string | undefined {
  const reverted = find(err, ContractFunctionRevertedError)

  // ⚠️ 顺序要紧:`Error(string)` 这种 revert 的 `errorName` 就是字面的
  // **`"Error"`** —— 一个字母都不多。先看 errorName 的话,界面上那行技术细节
  // 会显示成光秃秃一个 "Error",等于没说。真正有用的是 args[0] 那句文案
  // (如 "Blacklistable: account is blacklisted"),所以它排在最前。
  const args = reverted?.data?.args
  if (Array.isArray(args) && typeof args[0] === 'string') return clip(args[0])
  if (reverted?.reason) return clip(reverted.reason)
  if (reverted?.data?.errorName) return reverted.data.errorName

  const msg = err instanceof Error ? err.message : null
  if (!msg) return undefined
  return clip(msg.split('\n')[0].trim())
}

/** viem 的 message 常常是多行 + 一大段 "Docs: https://viem.sh/..." —— 砍短 */
function clip(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
