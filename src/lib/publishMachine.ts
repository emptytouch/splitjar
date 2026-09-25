import type { Hex } from 'viem'
import { UPLOAD_DEADLINE_SECONDS } from '../../shared/upload'
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES, type UploadTarget } from '../../shared/storage'
import type { PreviewDerivation } from './previewDerive'

/**
 * 发布流程状态机 —— **纯逻辑,不引 React,不碰网络**。
 *
 * 与 `payMachine` / `unlockMachine` 同一个写法。这里管的是
 * **从"选了文件"到"链上有了"** 的整条路:
 *
 * ```
 *  选文件 → 算哈希 → 签上传授权 → 直传 blob → 签创建交易 → 等上链
 *  pick    hashing   authorizing   uploading    creating     mining
 * ```
 *
 * ## ⚠️ 为什么是"先上传、后创建"(2026-09-23 定)
 *
 * 两个顺序都写得出来,选了先上传,因为**它保证凡是链上买得到的内容,
 * 背后一定有文件**。反过来(先创建后上传)如果上传失败,链上会留下一条
 * 买家能付钱、却没有文件的内容 —— 而合约里没有"文件存不存在"这个概念,
 * 拦不住。这个取舍写进了方案 §20。
 *
 * 代价有两个,都在下面各自处理:
 * ① 上传时链上还没登记,服务端第⑤步"链上归属"查不到 → 靠第⑥步 KV 先到先得
 *    (contentId 是本地随机生成、上链前外人不知道,抢注风险很小)。
 * ② 创建失败后重试**必须跳过上传** —— 平台禁止覆盖同一路径。见 `uploaded`。
 *
 * ## 两次钱包弹窗,必须说清楚
 *
 * `authorizing`(授权上传)和 `creating`(创建交易)都会弹钱包。
 * 第一次**不花钱**,第二次**要花 gas**。文案在 `PUBLISH_STEP_COPY` 里 ——
 * 不说明的话用户会以为被扣了两次钱,或者以为第二次是重复提交。
 */

/**
 * 步骤。
 *
 * `hashing` 由**选文件**触发(不是提交),其余四个由提交触发 ——
 * 放在同一个类型里是因为它们共享同一套"失败时该怎么解释"的规则。
 */
export type PublishStep = 'hashing' | 'authorizing' | 'uploading' | 'creating' | 'mining'

/** 提交之后才会走的步骤。`hashing` 不在其中 —— 它发生在提交之前 */
export type SubmitStep = Exclude<PublishStep, 'hashing'>

/**
 * 「备好的文件」—— 一路带着走的那几样东西。
 *
 * ⚠️ 把 `file` / `hash` / `preview` **绑在一个值里**,而不是拆成几个字段散在各状态上:
 * 它们必须同时有效。拆开的话会出现"哈希已经换成新的、文件还是旧的那个"
 * 这种组合,而那个组合的后果是**上链的指纹和实际传上去的文件对不上** ——
 * 买家下载完验一遍会发现对不上,而这个 bug 从签名那一步完全看不出来。
 *
 * ⚠️ `preview` 进这个值也是同一个理由:预览图**派生自** `file`。
 * 它要是留在外面,"换文件之后预览图还是上一份的"就成了一个表示得出来的状态 ——
 * 而那会让买家在广场上看到 A 的缩略图、点进去买的是 B。
 * (派生不出来的类型是 `unavailable` 而不是 null,见 `lib/previewDerive.ts`)
 */
export type Draft = { file: File; hash: Hex; preview: PreviewDerivation }

/**
 * 发布失败的**出路分类** —— 与 `payMachine.FailReason` / `unlockMachine.UnlockFailReason`
 * 同样按"用户该怎么办"分,不照抄错误码。
 *
 * ⚠️ 与那两者**刻意不合并**:付款的失败几乎全来自链,解锁的全来自服务端,
 * 发布这条既有服务端(上传授权)又有链(创建交易),合并会让两边都出现
 * 永远不可能发生的分支。
 *
 * ⚠️ 这里**没有**"文件太大""类型不对"这类 —— 那些是**选文件那一刻**的
 * 表单校验错误(见 `checkFile`),填错了当场就看得见,不会走到提交。
 */
export type PublishFailReason =
  /** 用户在钱包里点了拒绝。**这不是错误** */
  | 'user-rejected'
  /** 没连钱包 / 链不对。正常情况下按钮在那种时候根本不显示 */
  | 'not-connected'
  | 'wrong-chain'
  /** Blob / 网络不可用 —— 再试一次可能就好了 */
  | 'unavailable'
  /**
   * 请求不合形状,服务端回 `bad_request` / `bad_signature`。
   *
   * ⚠️ 这**几乎必然是前端自己的 bug** —— 服务端会拒的东西我们本就不该发。
   * 所以它和"链上 revert"不同,重试没有意义。
   */
  | 'protocol'
  /** 链上那笔创建交易失败(gas 不够、余额不够、合约 revert) */
  | 'chain'
  /**
   * ⚠️ **我们没等到收据,不代表交易没上链。**
   *
   * 与 `chain` 分开的唯一理由,与 `payMachine` 的 `receipt-timeout` 完全一样:
   * **它不能给一键重试**。交易很可能已经成功,只是回执还没回来 ——
   * 这时重试会让用户再签一次、再花一次 gas,而第二笔会 revert
   * (`ContentAlreadyExists`),gas 白花。
   *
   * 所以这条的出路是"去区块浏览器上自己看一眼",不是"再点一次"。
   */
  | 'chain-timeout'
  /**
   * 这份内容编号已经有主了(KV 先到先得 / 链上已登记在别人名下)。
   *
   * ⚠️ 与 `protocol` **分开是有意的**:它同样"重试没有用",但出路不一样 ——
   * `protocol` 是"我们发错了,得改代码",这条是"换一个内容编号再来"。
   * 而 contentId 是进页面时随机生成的、整个页面生命周期内不变,
   * 所以真正的出路是**重新开始**(拿一个新的编号),不是重试。
   *
   * 对正常用户这几乎不可能发生(contentId 是 32 字节密码学随机,
   * 而且上链前外人不知道)。真出现了,多半是自己上一次已经建过。
   */
  | 'claimed'

export type PublishState =
  /** 还没选文件 */
  | { k: 'editing' }
  /**
   * 正在算 keccak256 + 派生预览图。文件大的时候要一两秒。
   *
   * ⚠️ 两件事**共用这一个状态**,不拆成两个:它们都由"选文件"触发、
   * 都在提交之前完成、都在 `Draft` 里同时落地。拆开会让界面出现
   * "指纹好了但预览图还在转"这种中间态,而那对用户没有任何意义 ——
   * 他能做的动作(填价格)两件事没做完时本来就都能做。
   */
  | { k: 'hashing'; file: File }
  /** 文件备好了,可以提交 */
  | { k: 'ready'; draft: Draft }
  /**
   * 正在发布。
   *
   * `uploaded` 是**这次重试要不要跳过上传**的唯一依据 ——
   * 平台侧 `allowOverwrite` 默认 false,往一条已存在的 pathname 再传一次
   * 会被直接拒掉。所以"文件已经在上头了"这件事必须记在状态里,
   * 不能靠重试时重新判断。
   */
  | {
      k: 'working'
      draft: Draft
      step: SubmitStep
      uploaded: boolean
      /**
       * 创建交易的哈希。只有 `mining` 那一步才有 —— 界面用它显示
       * "已提交,正在等确认"和一个区块浏览器链接。
       *
       * ⚠️ 它进状态机而不是留在 hook 的局部 state 里,是因为**等回执靠的是一个
       * effect**(`useWaitForTransactionReceipt` 是 hook,没法在 async 函数里 await)。
       * 哈希一旦落在 hook 的局部 state,effect 与"当前在哪一步"就可能读到
       * 互相矛盾的两个版本 —— 那正是"卡在转圈"的成因。
       */
      txHash?: Hex
    }
  /** 链上确认了 */
  | { k: 'done'; draft: Draft; txHash: Hex }
  | {
      k: 'failed'
      draft: Draft
      step: SubmitStep
      reason: PublishFailReason
      detail?: string
      /** 倒下时文件传上去了没有 —— 决定重试从哪一步接上,也决定文案 */
      uploaded: boolean
    }

export type PublishAction =
  /** 用户选了文件(或换了一个)—— 开始算哈希 */
  | { type: 'pick'; file: File }
  /** 哈希算好了、预览图也派生好了(派生不出来时是 `unavailable`,同样是"好了") */
  | { type: 'hashed'; hash: Hex; preview: PreviewDerivation }
  /** 提交(首次或重试)。重试时按 `uploaded` 决定从哪一步接 */
  | { type: 'submit' }
  /** 推进步骤 */
  | { type: 'step'; step: SubmitStep }
  /** 创建交易已提交,拿到哈希 */
  | { type: 'sent'; txHash: Hex }
  /** 文件传上去了 */
  | { type: 'uploaded' }
  /**
   * 用户人工确认「文件其实已经传上去了」。
   *
   * 这条存在是因为有一种情况**我们判断不了**:PUT 的字节已经落地,
   * 但响应在回来的路上丢了(网络中断)。这时状态里 `uploaded` 是 false,
   * 直接重试会在上传那一步被平台以"不能覆盖"拒掉,而用户看到的是
   * "又失败了"。与其去猜(匹配平台的错误文案,猜错就会创建出一条
   * **没有文件的内容**),不如把这个判断交给用户 —— 他刚才是看着进度条
   * 传完的,他知道。
   */
  | { type: 'skip-upload' }
  | { type: 'done'; txHash: Hex }
  | { type: 'fail'; reason: PublishFailReason; detail?: string }
  | { type: 'reset' }

export const PUBLISH_INITIAL: PublishState = { k: 'editing' }

/** 取出"备好的文件"。还没备好就是 null */
export function draftOf(s: PublishState): Draft | null {
  switch (s.k) {
    case 'ready':
    case 'working':
    case 'done':
    case 'failed':
      return s.draft
    default:
      return null
  }
}

/**
 * 重试该从哪一步接上。
 *
 * ⚠️ 这是整个"先上传后创建"顺序里最容易写错的一处:
 * **文件传上去了就必须从 `creating` 接,不能从头再来** ——
 * 重来会在 `uploading` 撞上平台的防覆盖,把一个"只差最后一笔交易"
 * 的状态变成一个看起来彻底失败的状态。
 */
export function resumeStep(uploaded: boolean): SubmitStep {
  return uploaded ? 'creating' : 'authorizing'
}

export function isPublishing(s: PublishState): boolean {
  return s.k === 'working'
}

/** 发布占着流程的时候,表单要锁住 —— 改了价格再上链,签的和看到的就是两回事 */
export function locksForm(s: PublishState): boolean {
  return s.k === 'working'
}

export function publishReducer(state: PublishState, action: PublishAction): PublishState {
  switch (action.type) {
    case 'pick':
      // 换文件要把上一次的哈希丢掉重算 —— 留着的话会拿旧指纹去上链
      return { k: 'hashing', file: action.file }

    case 'hashed':
      // 只在"正在算"时接受结果。算到一半用户又换了一个文件时,
      // 旧那次的结果会在这里被丢弃(新的一次已经把它顶成 hashing 了)。
      // ⚠️ 指纹和预览图**一起收下或者一起丢掉** —— 见 `Draft` 那段
      return state.k === 'hashing'
        ? { k: 'ready', draft: { file: state.file, hash: action.hash, preview: action.preview } }
        : state

    case 'submit': {
      // 只有"文件已备好"或"失败了要重试"两种情形能提交。
      // 别的状态(比如正在算哈希)点不动 —— 按钮那边也会灰掉
      if (state.k === 'ready') return { k: 'working', draft: state.draft, step: 'authorizing', uploaded: false }
      if (state.k === 'failed') {
        return { k: 'working', draft: state.draft, step: resumeStep(state.uploaded), uploaded: state.uploaded }
      }
      return state
    }

    case 'step':
      // 推进到 `creating` / `mining` 时把上一个哈希丢掉 —— 留着会让界面
      // 在"还没提交"的时候显示一个上一次的链接
      return state.k === 'working'
        ? { ...state, step: action.step, txHash: action.step === 'creating' ? undefined : state.txHash }
        : state

    case 'sent':
      // 只从"正在创建"接受。迟到的回调不该让一个已经完成的流程回到等待态
      return state.k === 'working' && state.step === 'creating'
        ? { ...state, step: 'mining', txHash: action.txHash }
        : state

    case 'uploaded':
      return state.k === 'working' ? { ...state, uploaded: true } : state

    case 'skip-upload':
      // 从 working 或 failed 都能跳。含义都一样:别传了,文件在上头
      if (state.k === 'working') return { ...state, step: 'creating', uploaded: true }
      if (state.k === 'failed') {
        return { k: 'working', draft: state.draft, step: 'creating', uploaded: true }
      }
      return state

    case 'done':
      // 只有真正在走流程时才接受结果。迟到的回调打到 editing 上,
      // 会让一个空表单显示"已创建"
      return state.k === 'working' ? { k: 'done', draft: state.draft, txHash: action.txHash } : state

    case 'fail': {
      // 不在"工作中"收到失败 → 忽略(与 `unlockMachine` 同一条纪律:
      // 迟到的错误回调不该把已经成功的界面改成失败)
      if (state.k !== 'working') return state
      return {
        k: 'failed',
        draft: state.draft,
        step: state.step,
        reason: action.reason,
        detail: action.detail,
        uploaded: state.uploaded,
      }
    }

    case 'reset':
      return PUBLISH_INITIAL

    default: {
      const never: never = action
      return never
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// 选文件那一刻的门禁
// ────────────────────────────────────────────────────────────────────────

/**
 * 文件门禁的判定结果。
 *
 * ⚠️ 它**不是** `PublishFailReason`:这些错误在选文件那一刻就当场显示,
 * 属于表单校验(与"标题不能为空"同一类),不进状态机。
 */
export type FileProblem =
  | { k: 'empty' }
  | { k: 'too-large'; limitBytes: number }
  | { k: 'wrong-type'; target: UploadTarget; allowed: readonly string[] }
  /** 浏览器读不出这个文件的内容(被删了、权限变了)。算不出指纹就没法上链 */
  | { k: 'unreadable' }

/**
 * 选中的文件能不能传。
 *
 * ⚠️ **这一层是"早点告诉用户",不是安全边界。** 真正的强制在服务端
 * (`ALLOWED_CONTENT_TYPES` 由 `onBeforeGenerateToken` 交给平台)和平台侧
 * (`maximumSizeInBytes`)。前端查一遍只是因为"选了 300 MB 的文件、等它算完
 * 哈希、签完名、传到一半才失败"是很差的体验。
 *
 * 用**同一份** `MAX_UPLOAD_BYTES` / `ALLOWED_CONTENT_TYPES`(来自
 * `shared/storage.ts`)而不是另写一份数字:两处不一致的话,前端会放行一个
 * 服务端必拒的文件,而用户看到的是一次莫名其妙的失败。
 */
export function checkFile(file: File, target: UploadTarget): FileProblem | null {
  if (file.size === 0) return { k: 'empty' }

  const limit = MAX_UPLOAD_BYTES[target]
  if (file.size > limit) return { k: 'too-large', limitBytes: limit }

  const allowed = ALLOWED_CONTENT_TYPES[target]
  // `undefined` == 不限制类型 —— 内容文件就是这样(方案 §9.1:
  // 创作者传什么都有可能,列白名单会把正常用法挡在外面)
  if (allowed && !matchesAny(file.type, allowed)) {
    return { k: 'wrong-type', target, allowed }
  }
  return null
}

/**
 * 把 MIME 类型和一个形如 `['image/*']` 的清单比。
 *
 * 只支持 `type/*` 和 `type/subtype` 两种写法 —— 这就是
 * `ALLOWED_CONTENT_TYPES` 里全部的实际形态,不引入完整的 MIME 匹配库。
 */
function matchesAny(mime: string, allowed: readonly string[]): boolean {
  const m = mime.toLowerCase()
  return allowed.some((a) => {
    const pat = a.toLowerCase()
    if (pat.endsWith('/*')) return m.startsWith(pat.slice(0, -1))
    return m === pat
  })
}

/** 人话地描述一个文件门禁问题 */
export function describeFileProblem(p: FileProblem): string {
  switch (p.k) {
    case 'empty':
      return '这是一个空文件 —— 传上去买家也下不到东西。'
    case 'too-large':
      return `文件太大了。上限是 ${formatBytes(p.limitBytes)}。`
    case 'wrong-type':
      return `这个位置只收${p.target === 'preview' ? '图片' : '指定类型'}(${p.allowed.join(' / ')})。`
    case 'unreadable':
      return '读不出这个文件的内容 —— 可能它已经被移走或改过权限了。重新选一次试试。'
    default: {
      const never: never = p
      return never
    }
  }
}

/** 字节数说成人话。只用于提示文案,不需要精确到小数点后 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) {
    const mib = n / (1024 * 1024)
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`
  return `${n} B`
}

// ────────────────────────────────────────────────────────────────────────
// 文案
// ────────────────────────────────────────────────────────────────────────

/**
 * 「正在做什么」的文案。
 *
 * ⚠️ `authorizing` 与 `creating` **都会弹钱包**,必须分别说清楚:
 * 第一次不花钱(授权上传),第二次才花钱(创建交易)。不说明的话,
 * 刚从付款流程过来的用户会以为被扣了两次。
 */
export const PUBLISH_STEP_COPY: Record<PublishStep, { title: string; hint: string }> = {
  hashing: {
    title: '正在读取文件…',
    hint: '同时做两件事:算文件的 keccak256 指纹(会上链,买家下载完可以自己验一遍),以及从文件里生成一张带水印的预览图。',
  },
  authorizing: {
    title: '请在钱包里签名(第 1 次 · 不花钱)',
    hint: '这只是授权把文件传到我们的存储 —— 不上链、不花 gas。',
  },
  uploading: {
    title: '正在上传文件…',
    hint: '文件直接从你的浏览器传到存储,不经过我们的服务器。',
  },
  creating: {
    title: '请在钱包里签名(第 2 次 · 要花 gas)',
    hint: '这一笔才是真正的创建交易 —— 把价格和分账比例写进合约。',
  },
  mining: {
    title: '正在等待链上确认…',
    hint: '交易已提交,等它被打包。这一步不需要你再做任何事。',
  },
}

export type PublishCopy = { title: string; hint?: string; canRetry: boolean }

/**
 * 失败 → 文案与"能不能重试"。
 *
 * 放在这里而不是组件里,理由同另外两个状态机:**能不能重试是逻辑**。
 *
 * ⚠️ `step` 与 `uploaded` 一起决定措辞。最要紧的一条:
 * **文件已经传上去了、只是创建交易失败** 时,必须告诉用户"重试只补最后一笔,
 * 不用重新上传" —— 否则他会以为要重头来一遍,甚至以为文件白传了。
 */
export function describePublishFailure(
  reason: PublishFailReason,
  step: SubmitStep,
  uploaded: boolean,
): PublishCopy {
  // 与"走到哪一步"无关的三条先说完
  switch (reason) {
    case 'user-rejected':
      // 用户主动取消不是错误,别用报错的语气。
      // 但要说清楚**取消在哪一步** —— 第一次签名不花钱、第二次花钱,
      // 用户真正关心的是"我到底创建成功没有"
      return {
        title: '你取消了签名',
        hint: uploaded
          ? '创建交易没有发出去,链上什么都没变。文件已经传好了,重试会直接跳到创建这一步。'
          : '没有任何东西被写进链上,也没有文件被上传。',
        canRetry: true,
      }

    case 'not-connected':
      return { title: '先连接钱包', hint: '发布要用创作者的钱包签名,得先知道你是谁。', canRetry: false }

    case 'wrong-chain':
      return { title: '网络不对', hint: '需要切换到 Avalanche Fuji 测试网再发布。', canRetry: false }

    case 'protocol':
      return {
        title: '请求没被接受',
        hint: '这不是你操作的问题 —— 是前端发出去的东西不合服务端的形状。请把这个情况告诉我们,重试没有用。',
        canRetry: false,
      }

    case 'claimed':
      // 重试按钮没有意义:重试用的还是同一个 contentId,那正是被占用的那个。
      // 唯一有用的动作是"重新开始",所以 canRetry 为 false、让界面只给那一个出口
      return {
        title: '这个内容编号已经有主了',
        hint: '编号是进页面时随机生成的。点「重新开始」会换一个全新的编号,再建一次即可 —— 内容本身不用重选,但文件要重新传一遍。',
        canRetry: false,
      }

    case 'chain-timeout':
      // ⚠️ 这条**绝不能**给重试按钮 —— 见类型定义上那段
      return {
        title: '没等到链上的回执',
        hint: '这不等于失败:交易可能已经成功,只是回执还没回来,所以千万别重复提交。稍等片刻后打开看板看看有没有这条内容;也可以照着下面那行交易哈希去区块浏览器上查一眼。',
        canRetry: false,
      }

    default:
      break
  }

  // 上传那两步:无论失败原因是什么,链上都还没发生任何事
  if (step === 'authorizing' || step === 'uploading') {
    return {
      title: '文件没能传上去',
      hint: '网络或存储暂时出问题了。链上什么都没发生,重试即可。如果文件其实已经传完了(传到一半断网),下面有「文件已经传上去了」可以跳过上传。',
      canRetry: true,
    }
  }

  // 创建那两步 —— 这时文件已经在上头了,措辞必须反映这一点
  return {
    title: reason === 'chain' ? '创建交易失败了' : '发布没走完',
    hint: uploaded
      ? '链上这笔没成功(多半是 gas 不够或余额不足)。文件已经传好了,重试会跳过上传,只补交易这一笔。'
      : '链上这笔没成功。重试会从头再来一遍。',
    canRetry: true,
  }
}

/** 上传授权的有效期,分钟 —— 从 `shared/upload.ts` 来,免得两处各写一个数字 */
export const UPLOAD_DEADLINE_MINUTES = Math.round(UPLOAD_DEADLINE_SECONDS / 60)
