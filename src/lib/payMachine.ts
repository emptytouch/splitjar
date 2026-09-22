import type { Hex } from 'viem'

/**
 * 付款状态机 —— **纯逻辑,不引 React,可单独测**。
 *
 * 上游(开发计划 W3)原话:
 *   `idle → 校验 → 签名中 → 上链中 → 确认中 → 成功 / 失败`
 *   「钱包弹窗被关、用户拒绝签名、gas 不足、交易 pending 卡住、RPC 超时
 *     —— 每一种都必须映射到一个**明确的界面状态**,不能都落到'处理中'然后卡死。」
 *
 * ## 为什么用判别联合而不是一堆 `useState`
 *
 * 因为这个模块存在的**唯一**目的就是让那五种失败各自可见。散落的
 * `const [loading, setLoading] / [error, setError]` 能表达的合法组合数是
 * 指数级的,其中绝大多数是没意义的 —— 而"没意义的组合"正是"卡在转圈"
 * 的成因:某个分支忘了把 `loading` 置回 false。
 *
 * 判别联合把这件事变成编译期约束:`confirming` 这个状态**在类型上就带着 hash**,
 * 不可能渲染出"确认中但不知道在确认哪笔";`switch` 少写一个分支,
 * `noUnusedLocals` + 穷尽性检查会当场报错。
 *
 * ## 为什么是两笔交易(这不是 bug)
 *
 * `pay()` 内部走 `transferFrom`,所以首次购买必须先 `approve`。
 * 方案 §8.1 把 `approve + transferFrom` 冻结为有意为之的接口。
 * 状态机的责任是**让用户不误以为被扣了两次钱** —— 见 `STEP_COPY`。
 */

export type Step = 1 | 2

/**
 * 校验阶段(还没到签名)就拦下的问题。
 *
 * 与 `FailReason` 分开的理由:这些都是**可以提前查明**的,
 * 让用户签完名才告诉他"你早买过了"是在浪费他的时间和 gas。
 */
export type BlockReason =
  | 'wallet-not-connected'
  | 'wrong-chain'
  | 'content-not-found'
  | 'content-inactive'
  | 'already-purchased'
  | 'ownership-unknown' // 归属读失败 —— 见下方 OWNERSHIP_NOTE
  | 'insufficient-usdc'
  | 'insufficient-avax' // 开发计划 R3:买家无 AVAX 付 gas

/**
 * ⚠️ `ownership-unknown` 与 `already-purchased` **必须分开**,不能合并成
 * 「查不到 / 查到了就算买过」。
 *
 * 「查不到你的购买记录」时**唯一安全的方向是不放行**:`purchases` 那次读
 * 失败,页面没有依据说"你没买过",于是不能把付款按钮交出去 —— 用户会被
 * 引导去签一笔合约必然 revert(`AlreadyPurchased`)的交易,钱不丢,gas 白花。
 *
 * 反过来把它当成 `already-purchased` 也是错的:那会告诉一个**从没买过**的
 * 用户"你已经买过了"并给他一个下载按钮,点下去 /api/unlock 会返回 402。
 * 一个查不到就编造结论的页面,比一个说"我查不到"的页面更糟。
 *
 * (判据是 fail-closed:只有明确读到 `false` 才放行。见 `payGate.ts`。)
 */

/** 签名 / 上链阶段的失败 */
export type FailReason =
  | 'user-rejected' // 拒签,或直接关掉钱包弹窗
  | 'insufficient-usdc'
  | 'insufficient-avax'
  | 'insufficient-allowance' // 到第 2 笔才发现授权不够
  | 'already-purchased'
  | 'content-inactive'
  | 'content-not-found'
  | 'reverted' // 未归类的合约 revert
  | 'rpc-timeout' // 网络层超时 —— 方案 §14.2 要求「明确网络繁忙,不得显示成功」
  | 'receipt-timeout' // ⚠️ 见下方 RECEIPT_TIMEOUT_NOTE —— 这个**不等于失败**

/**
 * ⚠️ 本文件最容易写错的一条。
 *
 * `waitForTransactionReceipt` 超时只说明**我们没等到收据**,
 * 不说明交易没上链 —— 它可能已经成功,只是回执还没回来。
 *
 * 所以 `receipt-timeout` 与其它 `FailReason` 的处理方式**必须不同**:
 * 不给一键重试。交易可能已经成功,重试会让用户再签一次、再付一次。
 *
 * 兜底在合约:`purchases[contentId][buyer]` 会让第二次 `pay()` revert
 * `AlreadyPurchased`,所以钱不会被扣两次 —— 演示时这一点值得讲:
 * **状态机不确定的时候,链是最终裁判。**
 */
export const RECEIPT_TIMEOUT_NOTE =
  '交易可能已提交,只是回执还没回来。请先点上面的链接去区块浏览器确认,不要重复支付。'

export type PayState =
  /** 还没开始 */
  | { k: 'idle' }
  /** 正在校验:读内容 / 是否已购 / 余额 / gas */
  | { k: 'checking' }
  /** 校验拦下 —— 还没签名,不该让用户白签 */
  | { k: 'blocked'; reason: BlockReason }
  /** 等钱包签名。step 1 = approve,step 2 = pay */
  | { k: 'signing'; step: Step }
  /** 已广播,等收据 */
  | { k: 'pending'; step: Step; hash: Hex }
  /** 收据到手,等确认数。只有第 2 笔才需要 */
  | { k: 'confirming'; step: 2; hash: Hex }
  | { k: 'success'; hash: Hex }
  /** `hash` 只在部分失败里有(拿到了交易哈希之后才失败的) */
  | { k: 'failed'; step: Step; reason: FailReason; hash?: Hex; detail?: string }

export type PayAction =
  /** 用户点付款 / 点重试 —— 一律**重跑校验**,不直接重签 */
  | { type: 'start' }
  | { type: 'blocked'; reason: BlockReason }
  /**
   * 校验通过。
   *
   * `needsApprove` 由校验阶段查 `allowance` 得出:**额度已经够就直接进第 2 笔**。
   * 买过一次之后再买别的内容,授权通常还是满的,没必要再弹一次钱包。
   * 这时流程是「一笔」而不是两笔,`STEP_COPY` 的文案要相应换掉
   * (见 `usePayFlow` 里的 `needsApprove`)。
   */
  | { type: 'checked-ok'; needsApprove: boolean }
  /** 即将唤起钱包(在 `writeContract` 之前派发) */
  | { type: 'signing'; step: Step }
  /** 交易已广播,拿到哈希 */
  | { type: 'sent'; step: Step; hash: Hex }
  /** 第 1 笔(approve)的收据确认 → 直接进第 2 笔,不额外停留 */
  | { type: 'approve-confirmed' }
  /** 第 2 笔(pay)的收据确认 */
  | { type: 'pay-confirmed'; hash: Hex }
  | { type: 'confirmed'; hash: Hex }
  | { type: 'fail'; reason: FailReason; hash?: Hex; detail?: string }
  | { type: 'reset' }

export const INITIAL: PayState = { k: 'idle' }

/**
 * 当前处在第几笔。
 *
 * `fail` 动作**不携带 step**,由这里从当前状态推出来 —— 这样就不可能出现
 * "动作说是第 1 笔、实际在第 2 笔"这类自相矛盾的失败记录。
 */
function stepOf(s: PayState): Step | null {
  switch (s.k) {
    case 'signing':
      return s.step
    case 'pending':
      return s.step
    case 'confirming':
      return 2
    default:
      return null
  }
}

export function payReducer(state: PayState, action: PayAction): PayState {
  switch (action.type) {
    case 'start':
      // 从任何状态都能重新开始 —— 但入口一律是"重跑校验",
      // 因为失败的原因很可能正是校验能查出来的那些(余额、下架、已购)
      return { k: 'checking' }

    case 'blocked':
      return { k: 'blocked', reason: action.reason }

    case 'checked-ok':
      // 只从 checking 出发。其它状态下收到这个动作说明调用方有 bug,保持原状更容易发现
      if (state.k !== 'checking') return state
      return { k: 'signing', step: action.needsApprove ? 1 : 2 }

    case 'signing':
      return { k: 'signing', step: action.step }

    case 'sent':
      return { k: 'pending', step: action.step, hash: action.hash }

    case 'approve-confirmed':
      // 只在第 1 笔的 pending 上生效。**不停留、不展示"授权成功"** ——
      // 中间态对用户没有意义,只会让他以为流程走完了
      return state.k === 'pending' && state.step === 1 ? { k: 'signing', step: 2 } : state

    case 'pay-confirmed':
      return { k: 'confirming', step: 2, hash: action.hash }

    case 'confirmed':
      return { k: 'success', hash: action.hash }

    case 'fail': {
      const step = stepOf(state)
      // 不在任何"进行中"的状态里收到失败 → 忽略。
      // (StrictMode 下 effect 会跑两遍,迟到的错误回调可能打到已经重置的状态上)
      if (step === null) return state
      return { k: 'failed', step, reason: action.reason, hash: action.hash, detail: action.detail }
    }

    case 'reset':
      return INITIAL

    default: {
      // 穷尽性检查:新增 PayAction 而不处理,这里编译报错
      const never: never = action
      return never
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 文案与出路
//
// 放在这里而不是组件里,是因为"这个失败能不能重试"是**逻辑**不是样式 ——
// 它决定了要不要渲染重试按钮,写错了会让用户重复支付。
// 组件(`PayStatus.tsx`)只负责把下面这些渲染出来,不做判断。
// ─────────────────────────────────────────────────────────────

/** 失败/拦截之后,界面该给用户什么出路 */
export type Recovery =
  | { k: 'retry' } // 重试有意义
  | { k: 'faucet'; what: 'usdc' | 'avax' } // 去领测试币
  | { k: 'explorer'; hash: Hex } // 去链上自己查(收据超时专用)
  | { k: 'download' } // 已购买 → 去下载
  | { k: 'none' } // 没有出路,只能返回

export type Description = {
  title: string
  hint?: string
  recovery: Recovery
}

export function describeBlock(reason: BlockReason): Description {
  switch (reason) {
    case 'wallet-not-connected':
      return {
        title: '先连接钱包',
        hint: '付款需要一个钱包来签名。也可以让创作者把二维码发给你,用手机打开。',
        recovery: { k: 'none' },
      }
    case 'wrong-chain':
      return { title: '网络不对', hint: '需要切换到 Avalanche Fuji 测试网。', recovery: { k: 'none' } }
    case 'content-not-found':
      return { title: '内容不存在', hint: '链接可能不完整或已失效,跟创作者确认一下。', recovery: { k: 'none' } }
    case 'content-inactive':
      return { title: '该内容已下架', hint: '创作者已停止售卖,如果你之前买过仍可下载。', recovery: { k: 'none' } }
    case 'already-purchased':
      return { title: '你已经买过了', hint: '同一钱包不用重复购买。', recovery: { k: 'download' } }
    case 'ownership-unknown':
      // 语气要不一样:这不是"你不能买",是"我这一刻查不到",所以给重试而不是拒绝
      return {
        title: '查不到你的购买记录',
        hint: '链上查询没返回结果。为免你重复付款,先停在这里 —— 稍后重试即可。',
        recovery: { k: 'retry' },
      }
    case 'insufficient-usdc':
      return { title: 'USDC 不足', hint: '测试网的 USDC 可以从 Circle 水龙头免费领取。', recovery: { k: 'faucet', what: 'usdc' } }
    case 'insufficient-avax':
      return { title: 'AVAX 不足', hint: '付款要把交易发上链,需要一点 AVAX 付 gas。', recovery: { k: 'faucet', what: 'avax' } }
    default: {
      const never: never = reason
      return never
    }
  }
}

export function describeFailure(reason: FailReason, hash?: Hex): Description {
  switch (reason) {
    case 'user-rejected':
      // 用户主动取消**不是错误**,别用报错的语气
      return { title: '你取消了签名', hint: '没有任何资金被划走。', recovery: { k: 'retry' } }

    case 'insufficient-usdc':
      return { title: 'USDC 不足', hint: '可以从 Circle 水龙头免费领取测试币。', recovery: { k: 'faucet', what: 'usdc' } }

    case 'insufficient-avax':
      return { title: 'AVAX 不足', hint: '需要一点 AVAX 付 gas。', recovery: { k: 'faucet', what: 'avax' } }

    case 'insufficient-allowance':
      return { title: '授权额度不够', hint: '重新走一次授权即可,不会多扣钱。', recovery: { k: 'retry' } }

    case 'already-purchased':
      return { title: '这个钱包已经买过了', hint: '不用重复购买。', recovery: { k: 'download' } }

    case 'content-inactive':
      return { title: '该内容已下架', recovery: { k: 'none' } }

    case 'content-not-found':
      return { title: '内容不存在', hint: '链接可能已失效。', recovery: { k: 'none' } }

    case 'reverted':
      return { title: '交易被合约拒绝', hint: '钱没有划走。可以重试,或联系创作者。', recovery: { k: 'retry' } }

    case 'rpc-timeout':
      // 方案 §14.2:「明确'网络繁忙,重试',**不得显示成功**」
      return { title: '网络繁忙', hint: '没能连上节点。钱没有划走,可以重试。', recovery: { k: 'retry' } }

    case 'receipt-timeout':
      return {
        title: '还没等到交易回执',
        hint: RECEIPT_TIMEOUT_NOTE,
        recovery: hash ? { k: 'explorer', hash } : { k: 'none' },
      }

    default: {
      const never: never = reason
      return never
    }
  }
}

/**
 * 两笔交易的文案。
 *
 * ⚠️ 这是**用户体验上的关键点**:点一次"付款",钱包会弹两次。
 * 不解释清楚的话,用户会以为被扣了两次钱 —— 这是这一版最容易招差评的地方。
 * 所以每一步都写明"第几笔/共两笔",并且第 1 笔明说**不转账**。
 */
export const STEP_COPY = {
  /** 需要先授权 —— 首次购买走这条,钱包会弹两次 */
  1: {
    label: '第 1 / 2 步:授权 USDC',
    hint: '这一步不转账,只是允许合约在下一步代扣。授权本身不花钱。',
  },
  /** 第二步,或「授权额度还够」时唯一的一笔 */
  2: {
    label: '确认支付',
    hint: '这一步才会真正把钱按比例分给各方。',
  },
} as const

/**
 * 这一次到底要签几笔。
 *
 * 因为 `checked-ok` 可能跳过 approve,所以**不能**无条件显示"第 x / 2 步" ——
 * 只签一笔时写"第 1 / 2 步"会让用户以为流程没走完。
 */
export function stepCopy(step: Step, needsApprove: boolean) {
  if (!needsApprove) return { label: STEP_COPY[2].label, hint: STEP_COPY[2].hint }
  return step === 1
    ? { label: STEP_COPY[1].label, hint: STEP_COPY[1].hint }
    : { label: `第 2 / 2 步:${STEP_COPY[2].label}`, hint: STEP_COPY[2].hint }
}

/**
 * 「已提交、等上链」阶段的文案。
 *
 * ⚠️ 这个状态**必须**带上第几笔。原因很具体:`signing` 阶段写得清清楚楚
 * ("第 1 / 2 步:授权 USDC · 这一步不转账"),但钱包一点确认就转进 `pending`,
 * 而用户真正**盯着看**的就是这一段 —— 第 1 笔上链要几秒。不带上下文的话,
 * 这几秒会被读成"钱已经付了",然后钱包又弹第二次。
 *
 * 也就是说:最需要解释的那一段,恰恰是原来唯一没解释的一段。
 */
export function pendingCopy(step: Step, needsApprove: boolean) {
  if (!needsApprove) {
    // 授权额度还够,只有一笔 —— 不写"第 x / 2 步"
    return { title: '支付已提交,等待上链', hint: '钱正在按比例分给各方。' }
  }
  return step === 1
    ? {
        title: '第 1 / 2 步已提交:授权中',
        hint: '这一步不转账,授权上链后会自动接着走第 2 步付款。',
      }
    : {
        title: '第 2 / 2 步已提交:支付中',
        hint: '钱正在按比例分给各方。',
      }
}

/** 界面是否该显示为"正在处理" —— 集中一处,避免各组件各自判断漏掉某个状态 */
export function isBusy(s: PayState): boolean {
  return s.k === 'checking' || s.k === 'signing' || s.k === 'pending' || s.k === 'confirming'
}

/** 界面是否该在**任何情况下都不显示成功** —— 方案 §14.2 的硬要求 */
export function isSuccess(s: PayState): s is Extract<PayState, { k: 'success' }> {
  return s.k === 'success'
}
