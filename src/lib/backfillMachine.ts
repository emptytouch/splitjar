import { MAX_UPLOAD_BYTES } from '../../shared/storage'
import { formatBytes } from './publishMachine'
import type { PreviewDerivation } from './previewDerive'

/**
 * 「补预览图」的状态机 —— **纯逻辑,不引 React,不碰网络**。
 *
 * 与 `publishMachine` / `payMachine` / `unlockMachine` 同一个写法。
 *
 * ## 它补的是哪个洞
 *
 * 发布时预览图**上传失败是不挡发布的**(内容已经在存储里了,而预览图只是
 * 广场网格里的一张索引图,见 `hooks/usePublishFlow.ts`)。那条路刻意做成
 * 非致命 —— 但它留下了一个**没有回头路**的状态:内容发布成功、广场上这一件
 * 却没有缩略图。而这个状态是**看得见的**(`/explore` 上那一格是空的),
 * 创作者却没有任何入口去补。
 *
 * 所以这个状态机服务的是一条**收尾路径**,不是一个新功能。
 *
 * ## ⚠️ 形状与发布那条**刻意不同**:这里没有链上那一段
 *
 * 发布是 `签授权 → 传内容 → 传预览图 → 创建交易 → 等上链`,两次钱包弹窗,
 * 第二次**花钱**。补图只有 `核对文件 → 签授权 → 传预览图`:
 *
 * - **不上链**,所以没有 `creating` / `mining`,也没有 `chain` /
 *   `chain-timeout` 这两条失败原因。内容早就在链上了,这次改的只是一个 blob。
 * - **不花 gas**,所以那次签名不需要"第几次、花不花钱"的铺垫文案。
 *
 * 这也是**它不能和 `publishMachine` 合并**的理由:硬合并会造出一串
 * 永远走不到的分支,而"永远为假的分支"正是这个仓库一直在删的东西。
 * (同一条纪律见 `uploadApi.ts` 的 `CODE_TO_REASON` 注释。)
 *
 * ## ⚠️ 核对文件那一步是这个状态机里最要紧的一步
 *
 * 内容字节在**私有 store** 里,浏览器匿名读不到(403,这正是我们要的效果)
 * —— 所以补图时创作者得**在本机重新选一次原文件**(2026-09-25 决策)。
 * 那就必然存在"选错文件"这个可能,而它的后果很具体:
 *
 * **一张对不上的图会挂在广场上,买家点进去发现买的是别的东西。**
 *
 * 这比"没有缩略图"糟得多。所以核对不是可选的礼节,是这道流程的一部分:
 * 算一遍选中文件的 keccak256,和链上 `ContentRegistered.contentHash` 比,
 * 对不上就**在签名之前**停下 —— 一个字节都不会传出去。
 */

/** 派生成功的那一支。补图只在这一支上往下走 */
export type DerivedPreview = Extract<PreviewDerivation, { k: 'derived' }>

/** 会离开浏览器的两个步骤。`checking` 不在其中 —— 它纯本地 */
export type BackfillStep = 'authorizing' | 'uploading'

/**
 * 失败原因 —— 按"用户该怎么办"分,不照抄错误码。
 *
 * ⚠️ 与 `PublishFailReason` **刻意不合并**,虽然有几个同名的:
 * 发布那条有链上那一段(`chain` / `chain-timeout` / `claimed`),
 * 这条一个都不可能有;这条有核对文件那一段(`file-mismatch`),
 * 发布那条一个都不可能有。合并会让两边都长出一串死分支。
 *
 * ⚠️ 也**没有** `wrong-chain`:补图不上链、不花 gas,签名验的是 domain 里的
 * chainId(固定 43113),钱包当前连在哪条链上不影响这次签名能不能验过。
 */
export type BackfillFailReason =
  /** 用户在钱包里点了拒绝。**这不是错误** */
  | 'user-rejected'
  /** 没连钱包。正常情况下按钮在那种时候根本不显示 */
  | 'not-connected'
  /** 网络 / 存储不可用 —— 再试一次可能就好了 */
  | 'unavailable'
  /**
   * 请求不合形状,服务端回 `bad_request` / `bad_signature`。
   * **几乎必然是前端自己的 bug**,重试没有意义。
   */
  | 'protocol'
  /**
   * 服务端说这份内容不归这个地址(链上 creator 是别人 / KV 里已被别人认领)。
   *
   * ⚠️ 它对应的是 `UploadError` 的 `claimed`(服务端 code 是 `content_claimed`)。
   * **改名是有意的**:`claimed` 在发布那条路里的含义是"这个编号被别人占了,
   * 换一个编号再来",而在这里编号是**已有的**、换不掉,真正的出路是换个钱包。
   * 同名不同出路,合并只会让文案绑错(与 `unlockApi.ts` 那张表的注释同一个道理)。
   */
  | 'not-owner'
  /** 选中的文件**不是这一份内容** —— keccak256 与链上不符 */
  | 'file-mismatch'
  /** 选了个空文件 */
  | 'empty'
  /** 超过内容文件的上限 */
  | 'too-large'
  /** 浏览器读不出这个文件(被移走、权限变了) */
  | 'unreadable'

export type BackfillState =
  /** 还没选文件 */
  | { k: 'idle' }
  /**
   * 正在核对 + 派生。两件事并行跑,文件大的时候要一两秒。
   *
   * ⚠️ 与发布那条的 `hashing` 是同一个形状、同一个理由:两件事都由"选文件"
   * 触发、都在提交之前完成。这里更硬一层 —— 它们的结果**一起决定**要不要
   * 往下走(指纹不对 → 拒;派生不出 → 也是一种出路)。
   */
  | { k: 'checking' }
  /**
   * 核对通过、图也派生好了,**等着创作者看一眼再决定传不传**。
   *
   * ⚠️ 这个状态**必须存在**,不能"选完文件就自动传"。见文件末尾那段。
   */
  | { k: 'ready'; preview: DerivedPreview; hashVerified: boolean }
  /**
   * 这份文件派生不出预览图(PDF、压缩包、音频…)。
   *
   * ⚠️ 它是一个**独立状态,不是失败** —— 与 `lib/previewDerive.ts` 文件头
   * 里"允许无预览图发布"那条决策是同一件事的延续。显示成红框报错会让
   * 创作者以为自己做错了什么,然后去找一张根本不需要的图。
   */
  | { k: 'no-preview' }
  | { k: 'working'; preview: DerivedPreview; step: BackfillStep }
  | { k: 'done' }
  | {
      k: 'failed'
      reason: BackfillFailReason
      detail?: string
      /**
       * 手上还攥着的那张派生好的图。
       *
       * ⚠️ **它是"能不能重试"的唯一依据**,与发布那条的 `uploaded` 同一个角色:
       * 核对阶段就倒下的(选错文件、读不出来、派生不出)手上什么都没有,
       * 出路只能是**重新选文件**;已经走到签名/上传才倒下的,那张图还在,
       * 重试不用再选一次、也不用再算一遍哈希。
       */
      preview: DerivedPreview | null
    }

export type BackfillAction =
  /** 用户选了文件 —— 开始了 */
  | { type: 'start' }
  /** 核对与派生都做完了:指纹对上了(或核对不了)、图也出来了 */
  | { type: 'checked'; preview: DerivedPreview; hashVerified: boolean }
  /** 派生不出预览图 —— **正常出路**,不是失败 */
  | { type: 'no-preview' }
  /** 核对阶段就地拒绝(指纹不符 / 空文件 / 太大 / 读不出)。一个字节都没发出去 */
  | { type: 'refuse'; reason: BackfillFailReason; detail?: string }
  /** 提交(首次或重试)。重试时手上那张图原样接着用 */
  | { type: 'submit' }
  | { type: 'step'; step: BackfillStep }
  | { type: 'done' }
  | { type: 'fail'; reason: BackfillFailReason; detail?: string }
  /** 回到"还没选文件"。也用于"换一个文件" */
  | { type: 'reset' }

export const BACKFILL_INITIAL: BackfillState = { k: 'idle' }

/** 手上攥着的那张图。`checking` 之后才有,`no-preview` 之后永远没有 */
export function previewOf(s: BackfillState): DerivedPreview | null {
  switch (s.k) {
    case 'ready':
    case 'working':
      return s.preview
    case 'failed':
      return s.preview
    default:
      return null
  }
}

/**
 * 现在能不能提交(首次点「确认上传」,或者失败之后点「重试」)。
 *
 * ⚠️ 它**同时回答了"重试行不行"** —— 两者在这条路上是同一件事:
 * 都从 `authorizing` 起步、都用手上那张图。发布那条要分两种起点是因为
 * 它有一次"文件已经传上去了"的判断(`resumeStep`),这条没有中间态:
 * 要么一个字节都没传,要么传完了。
 */
export function canSubmit(s: BackfillState): boolean {
  if (s.k === 'ready') return true
  return s.k === 'failed' && s.preview !== null
}

/** 流程占着的时候,那一行的按钮要锁住 —— 否则同一张图会被签两次、传两遍 */
export function isBackfillBusy(s: BackfillState): boolean {
  return s.k === 'checking' || s.k === 'working'
}

export function backfillReducer(state: BackfillState, action: BackfillAction): BackfillState {
  switch (action.type) {
    case 'start':
      // 换文件要把上一次的结果整份丢掉重来 —— 留着会拿上一份的图去传
      return { k: 'checking' }

    case 'checked':
      // 只在"正在核对"时接受结果。核对到一半用户又选了一个文件时,
      // 旧那次的结果在这里被丢弃(新的一次已经把它顶成 checking 了)
      return state.k === 'checking'
        ? { k: 'ready', preview: action.preview, hashVerified: action.hashVerified }
        : state

    case 'no-preview':
      return state.k === 'checking' ? { k: 'no-preview' } : state

    case 'refuse':
      return state.k === 'checking'
        ? { k: 'failed', reason: action.reason, detail: action.detail, preview: null }
        : state

    case 'submit': {
      // `ready` 是首次提交;`failed` 且手上还有图才是重试。
      // 别的状态点不动 —— 按钮那边也会灰掉(见 `canSubmit`)
      if (state.k === 'ready') {
        return { k: 'working', preview: state.preview, step: 'authorizing' }
      }
      if (state.k === 'failed' && state.preview) {
        return { k: 'working', preview: state.preview, step: 'authorizing' }
      }
      return state
    }

    case 'step':
      return state.k === 'working' ? { ...state, step: action.step } : state

    case 'done':
      // 只有真正在走流程时才接受。迟到的回调打到 idle / ready 上,
      // 会让界面显示"传好了"而其实什么都没发生
      return state.k === 'working' ? { k: 'done' } : state

    case 'fail': {
      // 不在"能提交"的状态上收到失败 → 忽略(与 `publishMachine` 同一条纪律:
      // 迟到的错误回调不该把已经成功的界面改成失败)
      if (state.k === 'working' || state.k === 'ready') {
        return {
          k: 'failed',
          reason: action.reason,
          detail: action.detail,
          preview: state.preview,
        }
      }
      return state
    }

    case 'reset':
      return BACKFILL_INITIAL

    default: {
      const never: never = action
      return never
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// 文案
// ────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **这些字符串里不要写 markdown(`**加粗**`)。**
 *
 * 它们是**直接渲染**的,没有任何 markdown 解析 —— 所以 `**x**` 会原样显示成
 * 两个星号(2026-09-26 在真浏览器里截图核对过)。要强调就把话说清楚,
 * 或者把这句搬到组件里用 `<span className="text-neutral-300">`
 * (见 `DashboardPage` 的副标题),那里才有加粗的手段。
 *
 * ℹ️ 仓库里另有两处**已存在**的同类写法(不是这次改的):
 * `publishMachine.ts` 的"回执超时"那条、`unlockMachine.ts` 的
 * "下载链接换不出来"那条。它们同样会显示成星号,理由见上。
 */

/** 「正在做什么」的文案。⚠️ `checking` 是本地那一步,不弹钱包 */
export const BACKFILL_STEP_COPY: Record<'checking' | BackfillStep, { title: string; hint: string }> =
  {
    checking: {
      title: '正在核对这个文件…',
      hint: '两件事一起做:算它的 keccak256 指纹,跟链上记的那一份比;同时从它派生一张带水印的预览图。',
    },
    authorizing: {
      title: '请在钱包里签名(不花钱)',
      hint: '只是授权把预览图传到公开存储 —— 不上链、不花 gas。',
    },
    uploading: {
      title: '正在上传预览图…',
      hint: '图直接从你的浏览器传到公开 CDN,不经过我们的服务器。',
    },
  }

/**
 * 失败之后还有哪些动作可做。
 *
 * 与 `activeMachine` 的 `ActiveRecovery` 同一个分工:**状态机决定给什么出路,
 * 组件只负责把出路画成一个按钮**。所以"按钮上写什么"这种事不该散在组件里。
 */
export type BackfillRecovery =
  /** 再试一次,手上那张图原样接着用 —— 不用重新选文件 */
  | { k: 'retry' }
  /** 手上没有可用的图,只能重新选一个文件 */
  | { k: 'repick' }
  /** 没有可做的动作了。给一个"知道了"把面板收掉,别让用户对着一段死文案 */
  | { k: 'dismiss' }

export type BackfillCopy = {
  title: string
  hint?: string
  tone: 'bad' | 'warn'
  recovery: BackfillRecovery
}

/**
 * 失败 → 文案与出路。
 *
 * ⚠️ 措辞里最要紧的一条:**"指纹对不上"不是一次故障,是一次提醒。**
 * 它说明选错了文件 —— 说清楚"链上记的是另一个指纹"就够,别用
 * "校验失败"这种把人吓一跳的说法:那条路上什么都没坏。
 */
export function describeBackfillFailure(reason: BackfillFailReason): BackfillCopy {
  switch (reason) {
    case 'user-rejected':
      // 用户主动取消不是错误,别用报错的语气(与 `describePublishFailure` 同一条)
      return {
        title: '你取消了签名',
        hint: '什么都没传出去,广场上这一件还是没有缩略图。想补的时候再点一次就行。',
        tone: 'warn',
        recovery: { k: 'retry' },
      }

    case 'not-connected':
      return {
        title: '先连接钱包',
        hint: '要用创作者本人的钱包签名,服务端才知道这份内容确实归你。',
        tone: 'warn',
        recovery: { k: 'dismiss' },
      }

    case 'file-mismatch':
      return {
        title: '这个文件不是这一份内容',
        hint: '预览图是从内容文件派生出来的,所以得选「当初发布时传的那一个文件」。什么都不用改,重新选一次即可 —— 要是原件已经找不到了,就让它这样:没有缩略图不影响买卖。',
        tone: 'warn',
        recovery: { k: 'repick' },
      }

    case 'empty':
      return { title: '这是一个空文件', hint: '重新选一个。', tone: 'warn', recovery: { k: 'repick' } }

    case 'too-large':
      return {
        title: `文件太大了(上限 ${formatBytes(MAX_UPLOAD_BYTES.content)})`,
        hint: '内容文件本身的上限就是这个数 —— 你要找的那一份按理说不会超过它。',
        tone: 'warn',
        recovery: { k: 'repick' },
      }

    case 'unreadable':
      return {
        title: '读不出这个文件的内容',
        hint: '可能它已经被移走或改过权限了。重新选一次试试。',
        tone: 'warn',
        recovery: { k: 'repick' },
      }

    case 'not-owner':
      // 出路是换个钱包,而这个页面给不了 —— 所以按钮写"知道了",
      // 让用户把这个面板收掉,而不是反复点一个永远不成的重试
      return {
        title: '这份内容不归当前这个钱包',
        hint: '服务端按链上记录的创作者核对过 —— 只有当初创建它的那个地址才能补预览图。右上角换一个钱包再试。',
        tone: 'bad',
        recovery: { k: 'dismiss' },
      }

    case 'protocol':
      return {
        title: '请求没被接受',
        hint: '这不是你操作的问题 —— 是前端发出去的东西不合服务端的形状。请把这个情况告诉我们,重试没有用。',
        tone: 'bad',
        recovery: { k: 'dismiss' },
      }

    case 'unavailable':
      return {
        title: '预览图没能传上去',
        hint: '网络或存储暂时出问题了。签名不花钱,重试就是再签一次。⚠️ 如果上一次其实已经传完了(传到一半断网),重试会被存储的防覆盖挡下 —— 那种情况刷新一下看板,这一件应该已经有缩略图了。',
        tone: 'bad',
        recovery: { k: 'retry' },
      }

    default: {
      const never: never = reason
      return never
    }
  }
}

/**
 * 传成功了。
 *
 * ⚠️ 这里**只承诺已经发生的事**:"公开 store 里现在有这个 blob 了"。
 * 不说"广场上马上就能看到" —— 那是 `/api/previews` 下一次拉取之后的事,
 * 而且调用方会主动 refetch(见 `usePreviewBackfill`),但它与这句话之间
 * 隔着一个网络往返。少说一句不会错,多说一句就可能被打脸。
 */
export const BACKFILL_DONE_COPY = {
  title: '预览图已经传上去了',
  hint: '它在公开的 CDN 上,广场上这一件会有缩略图。刷新这一页可以看到入口消失。',
} as const

/**
 * 「核对不了」时那句必须说的话(见 `shared/contentHash.ts`)。
 *
 * ⚠️ 它是个**提示,不是错误**:这一类内容(链上指纹是零值)本来就没法核对,
 * 拦住的代价是它们永远补不上图。但也不能不说 —— 不说等于让创作者以为
 * 这张图被验过了,而它没有。
 */
export const HASH_UNVERIFIED_NOTE =
  '这一件的链上指纹是零值(创建于上传功能之前),所以这一次没法核对:你选的文件到底是不是原件,我们认不出来 —— 只能按你说的办。'
