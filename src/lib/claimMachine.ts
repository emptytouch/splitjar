import type { Hex } from 'viem'
import { classifyError, contractErrorName, revertText } from './payErrors'

/**
 * 「领取待提取余额」的状态机 —— `withdraw()` 专用的**极简版**。
 *
 * ## 为什么不复用 `payMachine`
 *
 * 付款是**两笔**(`approve` + `pay`),所以那个状态机有"第几笔"这个维度、
 * 有 `pendingCopy` / `stepCopy` 两套按步变化的文案。`withdraw()` 只有一笔、
 * 没有授权那一步,硬套过来会带进一堆永远不成立的组合(`confirming.step: 2`
 * 在取款里没有意义)—— 那正是 `payMachine` 开头那段注释反对的"没意义的组合"。
 *
 * ## ⚠️ 这个文件存在的唯一理由:把"取不出来"讲清楚
 *
 * `withdraw()` 失败的**最常见原因不是网络,是代币侧拒绝了这笔转账** ——
 * 收款地址被 Circle 拉黑、或者 USDC 被暂停。这时候:
 *
 *   - 说"网络繁忙,请重试"是**错的**,重试一百次也没用;
 *   - 说"交易被合约拒绝"是**没用**的,用户不知道该等什么;
 *   - 正确的话是:**钱还在合约里没丢,但解封之前谁也取不走**。
 *
 * 方案 §8.2 明确要求如实讲这一点("**不能宣传成'任何情况下钱都拿得到'**
 * —— 被拉黑的钱在解封前是动不了的。演示时如实讲这一点,比被评委问出来强")。
 * 所以这条文案不是措辞问题,是**这一版对 escrow 这个卖点的诚实边界**。
 */

export type ClaimFailReason =
  | 'user-rejected' // 拒签 —— 不是错误,是用户的正常选择
  | 'token-blacklisted' // ⭐ 收款地址被 Circle 拉黑 —— 重试无用,且不是你的错
  | 'token-paused' // ⭐ USDC 被暂停 —— 重试无用,但影响所有人且通常短暂
  | 'token-blocked' // ⭐ 代币 transfer 返回 false(非 FiatToken 形态的兜底)
  | 'nothing-to-withdraw' // 合约说没得取(正常情况下按钮不会出现)
  | 'insufficient-avax' // 没有 AVAX 付 gas
  | 'rpc-timeout'
  | 'receipt-timeout' // ⚠️ 同上,不等于失败
  | 'reverted' // 未归类的合约 revert

export type ClaimState =
  | { k: 'idle' }
  // 先 `simulateContract` 预演一次再发交易 —— 见 `ClaimPending` 里那段说明。
  // 这一步**不碰钱包**,所以要单独一个状态,不能借用 `signing` 的文案
  // ("请在钱包里确认"在预演阶段是假话)。
  | { k: 'checking' }
  | { k: 'signing' }
  | { k: 'pending'; hash: Hex }
  | { k: 'done'; hash: Hex }
  // `hash` 只在**交易已经广播出去之后**才可能有 —— 回执超时(`receipt-timeout`)
  // 靠它给出去区块浏览器核对的链接。签名阶段就失败的话没有哈希,这是正常的。
  | { k: 'failed'; reason: ClaimFailReason; hash?: Hex; detail?: string }

export type ClaimAction =
  | { type: 'check' }
  | { type: 'sign' }
  | { type: 'sent'; hash: Hex }
  | { type: 'done'; hash: Hex }
  | { type: 'fail'; reason: ClaimFailReason; detail?: string }
  | { type: 'reset' }

export const INITIAL_CLAIM: ClaimState = { k: 'idle' }

/** 正在预演 / 等钱包 / 等上链 —— 按钮要禁用,但**不能转圈转到天荒地老** */
export function isClaimBusy(s: ClaimState): boolean {
  return s.k === 'checking' || s.k === 'signing' || s.k === 'pending'
}

/**
 * 该不该给"重试"按钮。
 *
 * 三种 `token-*` 的出路是**等代币侧恢复**,不在这个页面上 ——
 * 给按钮等于承诺一件做不到的事。`nothing-to-withdraw` 的出路是重读余额,
 * 重读之后金额归零、按钮本来就消失了。
 *
 * 放在这里而不是组件里:这是个会写错的判断(写错就是让用户无限重试),
 * 而纯函数能单独验。组件只负责画。
 */
export function isDeadEnd(reason: ClaimFailReason): boolean {
  return reason.startsWith('token-') || reason === 'nothing-to-withdraw'
}

/** 是不是"被代币侧拦住"这一族 —— 界面用 warn 色而不是报错的红色 */
export function isTokenSide(reason: ClaimFailReason): boolean {
  return reason.startsWith('token-')
}

export function claimReducer(state: ClaimState, action: ClaimAction): ClaimState {
  switch (action.type) {
    case 'check':
      // 只有空闲或失败过才能重新发起 —— 已经成功的不能再来一次
      return state.k === 'idle' || state.k === 'failed' ? { k: 'checking' } : state

    case 'sign':
      // 预演通过了才轮到钱包
      return state.k === 'checking' ? { k: 'signing' } : state

    case 'sent':
      return state.k === 'signing' ? { k: 'pending', hash: action.hash } : state

    case 'done':
      return state.k === 'pending' || state.k === 'signing' ? { k: 'done', hash: action.hash } : state

    case 'fail':
      // 迟到的失败回调不该覆盖"已领取"—— StrictMode 下 effect 跑两遍时会出现
      if (state.k === 'checking' || state.k === 'signing') {
        return { k: 'failed', reason: action.reason, detail: action.detail }
      }
      // 已经从 `pending` 出发过的,把哈希带进失败态 —— 否则回执超时时
      // 用户手上连个能去链上核对的凭据都没有
      if (state.k === 'pending') {
        return { k: 'failed', reason: action.reason, hash: state.hash, detail: action.detail }
      }
      return state

    case 'reset':
      return INITIAL_CLAIM

    default: {
      const never: never = action
      return never
    }
  }
}

/**
 * 错误 → `ClaimFailReason`。
 *
 * 先认合约自定义错误(`WithdrawFailed` / `NothingToWithdraw`),辨认不出再交给
 * `classifyError` —— 那个函数是错误翻译层的唯一出处,这里**不重复实现**它,
 * 只把它的结果映射到本状态机的词汇表(因为它认识 `insufficient-allowance`、
 * `already-purchased` 这些取款场景里不可能出现的词)。
 */
export function classifyClaimError(err: unknown): ClaimFailReason {
  switch (contractErrorName(err)) {
    case 'WithdrawFailed':
      // 合约里 `usdc.transfer` 返回 false 才走到这 —— 即代币侧拒绝了。
      // ⚠️ 真实 Fuji USDC **不会**走到这里(见 `revertText` 的实测记录),
      //    它带 notBlacklisted 修饰符,在 require 那一步就挂了。
      //    留着是因为这是合约自己声明的失败形态,换一个代币就是它。
      return 'token-blocked'
    case 'NothingToWithdraw':
      return 'nothing-to-withdraw'
    default:
      break
  }

  // ⭐ 真实 USDC 的路径:`Error(string)` 里写着到底是什么拦住了
  const text = revertText(err)
  if (text) {
    // 黑名单要排在暂停前面 —— 两者措辞不重叠,但先判更具体的那个
    if (/blacklist/i.test(text)) return 'token-blacklisted'
    if (/paus(e|able|ed)/i.test(text)) return 'token-paused'
  }

  switch (classifyError(err, 1)) {
    case 'user-rejected':
      return 'user-rejected'
    case 'insufficient-avax':
      return 'insufficient-avax'
    case 'rpc-timeout':
      return 'rpc-timeout'
    case 'receipt-timeout':
      return 'receipt-timeout'
    default:
      // `insufficient-usdc` / `already-purchased` 之类在取款里没有意义,
      // 落到这里说明是我们没见过的形态 —— 不猜
      return 'reverted'
  }
}

export type ClaimRecovery =
  | { k: 'retry' }
  | { k: 'faucet'; what: 'avax' }
  | { k: 'explorer'; hash: Hex }
  | { k: 'wait' } // 唯一的出路是等对方解封,重试没有意义
  | { k: 'none' }

export type ClaimDescription = {
  title: string
  hint?: string
  recovery: ClaimRecovery
}

export function describeClaimFailure(reason: ClaimFailReason, hash?: Hex): ClaimDescription {
  switch (reason) {
    case 'user-rejected':
      return { title: '你取消了签名', hint: '钱还在合约里,随时可以再取。', recovery: { k: 'retry' } }

    case 'token-blacklisted':
      // ⭐ 这个状态机存在的理由。**不给重试按钮** —— 重试解决不了拉黑。
      //
      // 措辞上刻意做两件事:①把责任说清楚("不是我们的合约挡的"),
      // ②别让用户以为是自己操作错了 —— 拉黑是 Circle 的合规决定,
      // 和这个人点了几次"领取"没有任何关系。
      return {
        title: '这笔钱暂时取不出来',
        hint:
          '你的地址在 Circle(USDC 发行方)的黑名单上,USDC 合约拒绝给你转账 —— ' +
          '这一步根本没走到我们的合约。钱没有丢,还在合约里记着,也不会被别人取走。' +
          '解封时间由 Circle 决定,不取决于重试,所以我们这里不给你重试按钮。',
        recovery: { k: 'wait' },
      }

    case 'token-paused':
      return {
        title: 'USDC 现在暂停转账',
        hint:
          'Circle 把 USDC 合约暂停了 —— 这影响所有人,不是针对你。' +
          '钱在合约里好好的,恢复之后回来点一下就能取。',
        recovery: { k: 'wait' },
      }

    case 'token-blocked':
      return {
        title: '这笔钱暂时取不出来',
        hint:
          '代币合约拒绝了这次转账,和我们的合约无关,重试也不会变。' +
          '钱没有丢,还在合约里记着,等代币侧恢复后可以再取。',
        recovery: { k: 'wait' },
      }

    case 'nothing-to-withdraw':
      return {
        title: '没有可领取的余额',
        hint: '可能是刚才已经取过了 —— 上面的数字会刷成 0。',
        recovery: { k: 'none' },
      }

    case 'insufficient-avax':
      return { title: 'AVAX 不足', hint: '取款也是一笔链上交易,需要一点 AVAX 付 gas。', recovery: { k: 'faucet', what: 'avax' } }

    case 'rpc-timeout':
      return { title: '网络繁忙', hint: '没能连上节点。钱没有动,可以重试。', recovery: { k: 'retry' } }

    case 'receipt-timeout':
      return {
        title: '还没等到交易回执',
        hint: '交易可能已经提交,只是回执还没回来。先去区块浏览器确认,不要重复点。',
        recovery: hash ? { k: 'explorer', hash } : { k: 'none' },
      }

    case 'reverted':
      return { title: '交易被合约拒绝', hint: '钱没有动。可以重试一次,仍然不行就查链上记录。', recovery: { k: 'retry' } }

    default: {
      const never: never = reason
      return never
    }
  }
}
