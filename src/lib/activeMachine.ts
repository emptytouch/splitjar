import type { Hex } from 'viem'
import { classifyError, contractErrorName } from './payErrors'

/**
 * 「上架 / 下架」的状态机 —— `setContentActive()` 专用。
 *
 * ## 为什么不复用 `claimMachine`
 *
 * 同 `claimMachine` 不复用 `payMachine` 的理由:取款失败的一半词汇表
 * (`token-blacklisted` / `token-paused` / `nothing-to-withdraw`)在这里
 * **结构上不可能出现** —— `setContentActive` 不碰 USDC,一分代币都不转。
 * 硬套过来会带进一堆永远不成立的组合。
 *
 * ## ⚠️ 这个功能补的是什么
 *
 * 方案 §5.1 白纸黑字写着「创作者可 `setContentActive(contentId, false)`」,
 * 合约早就实现了、ABI 也早就有了 —— 但**全仓库零调用点**。后果是:
 * 一件内容一旦创建就**永远无法下架**,而方案 §14.2 那张异常状态表里的
 * 「已下架 → 显示"已下架",不显示支付按钮」**没有任何真实路径能走到**。
 *
 * ## ⭐ 这个状态机要讲清楚的那句话
 *
 * **下架 ≠ 收回。** 下架只拦**新的**买家(合约里 `pay()` revert
 * `ContentInactive`),**已经付过钱的人照常下载** —— 服务端门禁
 * (`api/unlock.ts`)只看 `hasPurchased`,从来不看 `active`。
 *
 * 这是产品语义,不是实现细节:创作者想"停售"时最怕的就是
 * "我会不会把已经买了的人一起坑了"。**所以他按下去之前就得知道答案。**
 * 界面上那句提示(见 `ActiveToggle`)和这里的成功文案,都是为这句话服务的。
 *
 * ⚠️ 与之配套的还有一处**必须同时成立**的改动:`payGate.ts` 里归属判断
 * 必须排在下架判断**之前**。否则买过的人在下架后会被闸门拦成
 * `content-inactive`(出路是死路 `none`),**连下载按钮都没有** ——
 * 那就是文案承诺"仍可下载"、UI 却做不到。两处是一件事的两半。
 */

export type ActiveFailReason =
  | 'user-rejected' // 拒签 —— 不是错误,是用户的正常选择
  | 'not-creator' // 合约 NotCreator —— 界面只给自己的内容画开关,正常走不到
  | 'content-not-found' // 合约 ContentNotFound —— 链上没有这件内容
  | 'insufficient-avax' // 没有 AVAX 付 gas
  | 'rpc-timeout'
  | 'receipt-timeout' // ⚠️ 同上,不等于失败
  | 'reverted' // 未归类的合约 revert

export type ActiveState =
  | { k: 'idle' }
  // 先 `simulateContract` 预演再发交易 —— 理由同 `ClaimPending`:不预演就会让
  // 用户签一笔注定 revert 的交易(`NotCreator` 就是这么被发现的)。
  // 这一步**不碰钱包**,所以要单独一个状态,不能借用 `signing` 的文案
  | { k: 'checking'; target: boolean }
  | { k: 'signing'; target: boolean }
  | { k: 'pending'; hash: Hex; target: boolean }
  // `target` 一路带着走,不是冗余:成功之后调用方才去 refetch,那之间有窗口期,
  // 这句文案要在这期间就**说对**(说反了比不说更糟 —— 用户会以为没生效又点一次)
  | { k: 'done'; hash: Hex; target: boolean }
  // `hash` 只在**交易已经广播出去之后**才可能有 —— 回执超时靠它给链上核对链接
  | { k: 'failed'; reason: ActiveFailReason; hash?: Hex; detail?: string }

export type ActiveAction =
  | { type: 'check'; target: boolean }
  | { type: 'sign' }
  | { type: 'sent'; hash: Hex }
  | { type: 'done'; hash: Hex }
  | { type: 'fail'; reason: ActiveFailReason; detail?: string }
  | { type: 'reset' }

export const INITIAL_ACTIVE: ActiveState = { k: 'idle' }

/** 正在预演 / 等钱包 / 等上链 —— 按钮要禁用 */
export function isActiveBusy(s: ActiveState): boolean {
  return s.k === 'checking' || s.k === 'signing' || s.k === 'pending'
}

/**
 * 该不该给"重试"按钮。
 *
 * `not-creator` 是**权限问题**,重试一百次结果一样 —— 出路是"换个钱包",
 * 而那不是这个组件能提供的东西,所以是死路。
 * `content-not-found` 的出路是重读列表(刷新之后那一行本来就该消失)。
 */
export function isActiveDeadEnd(reason: ActiveFailReason): boolean {
  return reason === 'not-creator' || reason === 'content-not-found'
}

export function activeReducer(state: ActiveState, action: ActiveAction): ActiveState {
  switch (action.type) {
    case 'check':
      // ⚠️ **`done` 也要放行** —— 这一条和 `claimReducer` 不同,是故意的。
      //
      // 取款成功之后钱已经到手,没有任何理由再点一次;但上下架是**开关**:
      // 刚下架完的人很可能马上想改回去(试一下效果 / 手滑了)。若把 `done`
      // 锁死,他就只能刷新页面才能切回来 —— 一个纯粹自找的体验坑。
      //
      // 安全性不靠这个锁:按钮上写的是**相反**的动作(`active` 变了),而且
      // 每次都会重新预演 + 重新签名,不存在"重复提交同一笔"的可能。
      return state.k === 'idle' || state.k === 'failed' || state.k === 'done'
        ? { k: 'checking', target: action.target }
        : state

    case 'sign':
      return state.k === 'checking' ? { k: 'signing', target: state.target } : state

    case 'sent':
      return state.k === 'signing' ? { k: 'pending', hash: action.hash, target: state.target } : state

    case 'done':
      return state.k === 'pending' ? { k: 'done', hash: action.hash, target: state.target } : state

    case 'fail':
      // 迟到的失败回调不该覆盖"已完成"—— StrictMode 下 effect 跑两遍时会出现
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
      return INITIAL_ACTIVE

    default: {
      const never: never = action
      return never
    }
  }
}

/**
 * 错误 → `ActiveFailReason`。
 *
 * 先认合约自定义错误(`NotCreator` / `ContentNotFound`),辨认不出再交给
 * `classifyError` —— 那个函数是错误翻译层的唯一出处,这里**不重复实现**它,
 * 只把结果映射到本状态机的词汇表(它认识 `content-inactive`、
 * `already-purchased` 这些上下架场景里不可能出现的词)。
 */
export function classifyActiveError(err: unknown): ActiveFailReason {
  switch (contractErrorName(err)) {
    case 'NotCreator':
      // 只有内容的创建者能改上下架。界面本来就只给自己的内容画开关,
      // 所以走到这里通常意味着**连错钱包了** —— 文案要往那儿引,见 describe
      return 'not-creator'
    case 'ContentNotFound':
      return 'content-not-found'
    default:
      break
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
      // `content-inactive` / `already-purchased` 之类在这里没有意义,
      // 落到这里说明是我们没见过的形态 —— 不猜
      return 'reverted'
  }
}

export type ActiveRecovery =
  | { k: 'retry' }
  | { k: 'faucet'; what: 'avax' }
  | { k: 'explorer'; hash: Hex }
  | { k: 'switch-wallet' } // 出路是换个钱包,这个页面做不到
  | { k: 'none' }

export type ActiveDescription = {
  title: string
  hint?: string
  recovery: ActiveRecovery
}

/** 成功文案 —— `target` 决定说的是"已下架"还是"已上架" */
export function describeActiveSuccess(target: boolean): { title: string; hint: string } {
  return target
    ? {
        title: '✓ 已重新上架',
        hint: '新买家现在可以付款了。',
      }
    : {
        title: '✓ 已下架',
        hint: '新买家看不到付款按钮了 —— 已有的付款不受影响,已购者仍可下载。',
      }
}

/**
 * 进行中文案 —— 挂在按钮上。
 * ⚠️ 三态要分开:预演**不碰钱包**,说"请在钱包里确认"是假话。
 */
export function activeBusyLabel(s: ActiveState): string {
  switch (s.k) {
    case 'checking':
      return '正在核对…'
    case 'signing':
      return '请在钱包里确认…'
    case 'pending':
      return s.target ? '正在上架…' : '正在下架…'
    default:
      return ''
  }
}

export function describeActiveFailure(reason: ActiveFailReason, hash?: Hex): ActiveDescription {
  switch (reason) {
    case 'user-rejected':
      return {
        title: '你取消了签名',
        hint: '内容还是原来的状态,随时可以再改。',
        recovery: { k: 'retry' },
      }

    case 'not-creator':
      // 界面只给自己的内容画开关,所以这条几乎只有一个原因:钱包换了。
      // 说"你没有权限"会让用户去怀疑产品,而真实原因通常在他自己那边。
      return {
        title: '这个钱包不是内容的创建者',
        hint:
          '链上只允许创建者改上下架。你现在的钱包和你创建内容时用的不是同一个 —— ' +
          '切回创建它的那个钱包再来一次。',
        recovery: { k: 'switch-wallet' },
      }

    case 'content-not-found':
      return {
        title: '链上找不到这件内容',
        hint: '可能是列表过期了 —— 刷新一下,这一行应该会消失。',
        recovery: { k: 'none' },
      }

    case 'insufficient-avax':
      return {
        title: 'AVAX 不足',
        hint: '上下架是一笔链上交易,需要一点 AVAX 付 gas。',
        recovery: { k: 'faucet', what: 'avax' },
      }

    case 'rpc-timeout':
      return {
        title: '网络繁忙',
        hint: '没能连上节点。内容状态没有变,可以重试。',
        recovery: { k: 'retry' },
      }

    case 'receipt-timeout':
      return {
        title: '还没等到交易回执',
        hint: '交易可能已经提交,只是回执还没回来。先去区块浏览器确认,不要重复点。',
        recovery: hash ? { k: 'explorer', hash } : { k: 'none' },
      }

    case 'reverted':
      return {
        title: '交易被合约拒绝',
        hint: '内容状态没有变。可以重试一次,仍然不行就查链上记录。',
        recovery: { k: 'retry' },
      }

    default: {
      const never: never = reason
      return never
    }
  }
}
