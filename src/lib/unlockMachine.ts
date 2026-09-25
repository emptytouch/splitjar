/**
 * 解锁(下载)状态机 —— **纯逻辑,不引 React,不碰网络**。
 *
 * 与 `payMachine.ts` 同一个写法,理由也一样:散落的 `useState` 能表达的
 * 合法组合是没意义的指数级,而"没意义的组合"正是"卡在转圈"的成因。
 *
 * ## 它与付款流程的关系:**完全独立**
 *
 * 付款写链,解锁只签名(不花 gas、不上链)。所以这里没有 `hash` 字段,
 * 也没有"第几笔"的概念 —— 那些是付款的事。
 *
 * ## ⚠️ 一次解锁里,`nonce` 只用一次
 *
 * 服务端在签发下载 URL 的**最后一步**把 nonce 删掉(见 `api/unlock.ts`)。
 * 所以:**任何失败之后重试,都必须重新取一个 nonce** —— 这也是为什么
 * 每次重试都从 `step: 'nonce'` 重新走,而不是复用上一次的。
 */

/**
 * 卡在哪一步。三张"牌"对应三次可能失败的等待:
 * 跟服务端要 nonce → 等钱包签名 → 拿签名换 URL。
 */
export type UnlockStep = 'nonce' | 'sign' | 'unlock'

/**
 * 失败原因。
 *
 * 与 `payMachine` 的 `FailReason` **刻意不合并**:付款的失败大多来自链
 * (gas、余额、revert),解锁的失败大多来自服务端。混成一个联合会让两边
 * 都出现永远不可能发生的分支。
 *
 * ## 为什么按"用户该做什么"分,而不是照抄服务端的 `code`
 *
 * 服务端有 10 个 `ApiErrorCode`(见 `shared/api.ts`),但它们归到用户这里
 * 只有 8 种**不同的出路**。所以这里做的是**语义映射**:
 * `nonce_expired` / `nonce_mismatch` / `deadline_expired` 三个 code
 * 都落到 `expired` —— 因为对用户来说,唯一正确的反应都是"再点一次"。
 *
 * 而服务端那个原始 `code` **不会丢**:它进 `detail`,由界面以小字原样显示。
 * 这样精确性还在(排查时看得到),但用户看到的第一行永远是"我该怎么办"。
 */
export type UnlockFailReason =
  /** 用户在钱包里点了拒绝,或直接关掉弹窗 —— **这不是错误** */
  | 'user-rejected'
  /** 没连钱包 / 链不对。正常情况下按钮在那种时候根本不显示 */
  | 'not-connected'
  | 'wrong-chain'
  /** 链上说你没买过这份内容 */
  | 'not-purchased'
  /** nonce 过期/用过了,或签名里的 deadline 过了 —— 重试即可,会拿到新 nonce */
  | 'expired'
  /**
   * 签名验不过。
   *
   * ⚠️ 正常情况下**不该发生**,它是"前端与服务端的 EIP-712 定义分叉了"的信号
   * (domain 或字段顺序不一致,见 `shared/eip712.ts` 的头部)。
   * 所以文案要指向这个真实原因,而不是让用户"再试一次" —— 再试一百次也不会好。
   */
  | 'signature'
  /**
   * 上游或网络出问题(Blob / KV / RPC 不可用,或纯网络失败)。
   *
   * **与 `protocol` 分开是有意的**:这条是"再试一次可能就好了",
   * 而 `protocol` 是"再试也没用,得改代码"。混起来会让重试按钮
   * 出现在一个永远不会成功的场景里。
   *
   * 具体是哪一步要看 `UnlockState.failed.step` —— 文案不同(见 describe)。
   */
  | 'unavailable'
  /**
   * 请求本身不合形状 —— 服务端回 `bad_request`。
   *
   * ⚠️ 这**几乎必然是前端自己的 bug**(比如 contentId 没归一化就发出去了),
   * 因为服务端会拒掉的东西我们本就不该发。所以它和 `signature` 一样,
   * 属于"指向我们自己"的一类,不给重试。
   */
  | 'protocol'

export type UnlockState =
  /** 还没开始。按钮显示「下载内容」 */
  | { k: 'idle' }
  /** 正在走流程,`step` 决定文案 */
  | { k: 'working'; step: UnlockStep }
  /**
   * 拿到下载 URL 了。
   *
   * `expiresAt` 是**绝对时刻(ms)**,不是剩余秒数 —— 剩余量随时间流逝而变,
   * 存成状态就必须有个定时器去改它,而定时器和真实时间很容易走岔。
   * 存绝对时刻,让渲染层每次拿 `Date.now()` 去减,永远不会算错。
   */
  | { k: 'ready'; url: string; expiresAt: number }
  | { k: 'failed'; step: UnlockStep | null; reason: UnlockFailReason; detail?: string }

export type UnlockAction =
  | { type: 'start' }
  /** 推进到下一步(在发起那次等待**之前**派发) */
  | { type: 'step'; step: UnlockStep }
  | { type: 'ready'; url: string; expiresAt: number }
  | { type: 'fail'; reason: UnlockFailReason; detail?: string }
  | { type: 'reset' }

export const UNLOCK_INITIAL: UnlockState = { k: 'idle' }

/** 失败时"卡在哪一步"从当前状态推出,不由动作携带 —— 与 `payMachine.stepOf` 同理 */
function stepOf(s: UnlockState): UnlockStep | null {
  return s.k === 'working' ? s.step : null
}

export function unlockReducer(state: UnlockState, action: UnlockAction): UnlockState {
  switch (action.type) {
    case 'start':
      return { k: 'working', step: 'nonce' }

    case 'step':
      // 只在"工作中"推进。已经拿到 URL 之后迟到的 step 不该把它打回等待态
      return state.k === 'working' ? { k: 'working', step: action.step } : state

    case 'ready':
      return { k: 'ready', url: action.url, expiresAt: action.expiresAt }

    case 'fail': {
      const step = stepOf(state)
      // 不在"工作中"收到失败 → 忽略。
      // (异步流程里迟到的错误回调可能打到已经成功的状态上;把它改成失败
      //  就是"下载其实成功了,界面却说失败")
      if (step === null) return state
      return { k: 'failed', step, reason: action.reason, detail: action.detail }
    }

    case 'reset':
      return UNLOCK_INITIAL

    default: {
      const never: never = action
      return never
    }
  }
}

/** 界面上"正在忙"的三种状态 —— 集中一处,免得某个组件漏判一种 */
export function isUnlocking(s: UnlockState): boolean {
  return s.k === 'working'
}

/** 还剩多少秒可用。已过期返回 0(不返回负数 —— 负的剩余时间在界面上没有意义) */
export function secondsLeft(expiresAt: number, nowMs: number = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - nowMs) / 1000))
}

export type UnlockCopy = { title: string; hint?: string; canRetry: boolean }

/**
 * 失败 → 文案与"能不能重试"。
 *
 * 放在这里而不是组件里,理由同 `payMachine`:**能不能重试是逻辑**。
 * 判错了会让用户对着一个永远不会成功的按钮反复点。
 *
 * ⚠️ `step` 只影响 `unavailable` 的措辞 —— 在"要 nonce"那一步失败时
 * 用户什么都还没做(没签名、没损失);在"换链接"那一步失败时
 * **他已经签过一次名了**,不解释清楚他会以为签名被用掉了、要重来一遍。
 */
export function describeUnlockFailure(reason: UnlockFailReason, step: UnlockStep | null): UnlockCopy {
  switch (reason) {
    case 'user-rejected':
      // 用户主动取消不是错误,别用报错的语气
      return { title: '你取消了签名', hint: '没有任何东西被扣走,也没有下载任何文件。', canRetry: true }

    case 'not-connected':
      return { title: '先连接钱包', hint: '解锁要用买家的钱包签名,得先知道你是谁。', canRetry: false }

    case 'wrong-chain':
      return { title: '网络不对', hint: '需要切换到 Avalanche Fuji 测试网再下载。', canRetry: false }

    case 'not-purchased':
      return {
        title: '链上还没查到这笔购买',
        hint: '服务端读的是另一个节点,可能比你的钱包慢一点。等几秒再试 —— 如果一直这样,把交易哈希发给创作者核对。',
        canRetry: true,
      }

    case 'expired':
      return {
        title: '一次性凭证已过期',
        hint: '重新点一次就行,会换一张新的。',
        canRetry: true,
      }

    case 'signature':
      // ⚠️ 这条**指向我们自己**,不指向用户
      return {
        title: '签名校验没通过',
        hint: '这不是你操作的问题 —— 多半是前端和服务端的签名定义对不上了。请把这个情况告诉创作者,重试没有用。',
        canRetry: false,
      }

    case 'unavailable':
      return step === 'nonce'
        ? {
            title: '服务暂时不可用',
            hint: '没能从服务端取到一次性凭证。你还没有签名,什么都没发生 —— 等几秒再试一次。',
            canRetry: true,
          }
        : {
            title: '网络繁忙',
            hint: '服务端在换下载链接时没响应。你刚才那次签名并没有被用掉,直接重试即可。',
            canRetry: true,
          }

    case 'protocol':
      return {
        title: '请求没被接受',
        hint: '这不是你操作的问题 —— 是前端发出去的东西不合服务端的形状。请把这个情况告诉创作者,重试没有用。',
        canRetry: false,
      }

    default: {
      const never: never = reason
      return never
    }
  }
}

/**
 * 「正在做什么」的文案。
 *
 * ⚠️ 三次等待都必须**分别说清楚**,尤其 `sign` 那一步 —— 钱包会弹一个
 * 看起来像"又要付钱"的签名框。不明说的话,刚从付款流程走过来的买家
 * 会以为被扣了第二次钱。所以那一条明写「不花钱、不上链」。
 */
export const UNLOCK_STEP_COPY: Record<UnlockStep, { title: string; hint: string }> = {
  nonce: {
    title: '正在准备一次性凭证…',
    hint: '向服务端要一个只能用一次的编号,防止这张签名被重复使用。',
  },
  sign: {
    title: '请在钱包里签名',
    hint: '这一步只是证明「你是你」—— 不花钱、不上链、不产生交易。',
  },
  unlock: {
    title: '正在换下载链接…',
    hint: '服务端在核对链上的购买记录,然后签一条 60 秒有效的链接。',
  },
}
