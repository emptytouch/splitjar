import type { Hex } from 'viem'
import { normalizeTitle } from '../../shared/contentMeta'

/**
 * 内容的**链下易读信息**(目前只有标题)。
 *
 * ## ⚠️ 为什么标题不在链上(2026-09-22 确认的方案缺口)
 *
 * 合约的 `Content` struct 只有 `creator / price / contentHash / recipients /
 * splits / active` —— **没有标题字段**,`ContentRegistered` 事件里也没有。
 * 而 W3 的 `/create` 要求填标题、付费页要让买家知道自己在买什么。
 *
 * 所以标题必须走链下。这一版用两条路:
 *
 *   ① **分享链接**:`/p/0x…?t=标题` —— 买家打开就能看到
 *   ② **本机缓存**:创建者自己的浏览器里留一份,看板据此显示
 *
 * ## 这个方案的局限,必须如实说明
 *
 * ① 链接里的标题**不是权威的** —— 改 URL 就能改。它只用于展示,
 *    **不参与任何校验,也绝不影响价格和分账**(那两个一律从链上读)。
 * ② 买家手动输 contentId(不带 `?t=`)时没有标题。
 * ③ 换台电脑就看不到缓存。
 *
 * 方案 §10 描述的正解是 **Vercel KV**("体验模式的 demo-pay 在代发交易时
 * 顺手把易读记录写进 KV,前端优先读 KV,缺失时回退链上 getLogs")。
 * 但那要先有真实 Vercel 部署 + 开通 KV,属于 W8。**W5 没做这件事** ——
 * 那一步接的是上传归属(`server/kv.ts` 的 `claimUploader`),与标题无关。
 * 标题写进 KV 仍然留给 W8。
 *
 * ## ⚠️ 2026-09-26:KV 那条路的两半都落地了,所以上面那句"局限"要改口
 *
 * 上面 ①②③ 三条局限里,**② 和 ③ 已经不再是必然** —— 只是当时的实现还没跟上:
 *
 * | | 什么时候落地的 |
 * |---|---|
 * | **写** KV | W8:`POST /api/content-meta`(创作者上链回执之后写),`usePublishFlow.ts` 调它 |
 * | **读** KV | 2026-09-26:本文件新增 `resolveTitle`,看板据此读 `GET /api/catalog` |
 *
 * ⚠️ **读的入口是 catalog,不是另开的端点** —— 这是服务端自己定的
 * (`api/content-meta.ts` 文件尾那段:"读标题的正当入口是 `GET /api/catalog`,
 * 单开一个 `GET` 会多一条要维护、要鉴权、要限流的路")。所以这里必须接受
 * catalog 的一个既定性质:**它只收「在售」的内容**(`active && price > 0`,
 * 见 `api/catalog.ts`)。下架的内容永远不在那份列表里 —— 这不是 bug,
 * 是商品目录该有的语义,而看板不是商品目录。代价见 `resolveTitle` 的注释。
 *
 * ① 仍然成立:标题**永远不是权威的**(分享链接里那个仍然可以随手改),
 * 不参与任何校验,也绝不影响价格和分账 —— 那两个一律从链上读。
 */
const LS_KEY = 'splitjar.content.v1'

export type LocalContent = {
  contentId: Hex
  title: string
  /** 本地记录时间戳 —— 仅用于排序,链上另有真实时间 */
  createdAt: number
}

/**
 * localStorage 在隐私模式 / 禁用 Cookie 时会**抛异常**(不是返回 null)。
 * 所以每一次读写都要包 —— 让"存不了"降级成"这次不记",而不是白屏。
 */
function readAll(): LocalContent[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is LocalContent =>
        typeof x === 'object' && x !== null && typeof (x as LocalContent).contentId === 'string',
    )
  } catch {
    return []
  }
}

function writeAll(items: LocalContent[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(items))
  } catch {
    // 存不进去就算了 —— 标题是锦上添花,不能因为它失败而中断创建流程
  }
}

/** 创建成功后记一笔。重复 contentId 覆盖,不追加 */
export function rememberContent(contentId: Hex, title: string): void {
  if (!title.trim()) return
  const rest = readAll().filter((c) => c.contentId !== contentId)
  writeAll([{ contentId, title: title.trim(), createdAt: Date.now() }, ...rest])
}

export function getRememberedContent(contentId: Hex): LocalContent | undefined {
  return readAll().find((c) => c.contentId === contentId)
}

/** 按最近创建排序 —— 看板用 */
export function listRememberedContents(): LocalContent[] {
  return readAll()
}

/** 忘掉一条(看板不需要它;留着是为了将来"删除本地记录") */
export function forgetContent(contentId: Hex): void {
  writeAll(readAll().filter((c) => c.contentId !== contentId))
}

/**
 * ⚠️ `TITLE_MAX` / `normalizeTitle` **2026-09-23(W7)已挪到 `shared/contentMeta.ts`**,
 * 本文件不再定义它们。
 *
 * 挪的理由:服务端新加的 `POST /api/content-meta` 在写 KV 之前要按**同一套规则**
 * 规范化标题,而服务端 import 不了 `src/lib/`(这份代码带着 `window`,
 * 且 `tsconfig.api.json` 不带 DOM)。两个「同一件必须两端一致的事」分家,
 * 迟早会漂移成"前端截 40、服务端不截"。
 *
 * 需要它的地方请直接从 `../../shared/contentMeta` 取。
 */

/**
 * 拼分享链接。
 *
 * 用 `URLSearchParams` 而不是手拼 `?t=` —— 标题里很可能有空格、
 * `&`、中文、emoji,手拼一定会漏掉某一种。二维码里一个转义错误就是扫不开。
 */
export function buildShareUrl(contentId: Hex, title: string): string {
  const base = `${window.location.origin}/p/${contentId}`
  const t = normalizeTitle(title)
  return t ? `${base}?${new URLSearchParams({ t })}` : base
}

/** 从 `useSearchParams` 拿到的参数里读标题。拿不到就返回空串(不是 undefined) */
export function readTitleParam(params: URLSearchParams): string {
  return normalizeTitle(params.get('t') ?? '')
}

/* ───────────────────────── 标题的三个来源 ───────────────────────── */

/**
 * 一行的标题 —— **四态,不是一个字符串**。
 *
 * ## 为什么不能就是一个 `string`
 *
 * 标题有**两个**来源(服务端 KV / 本机 localStorage),而且服务端那份**可能读不到**。
 * 用一个 `string` 表示就有两种坏法:
 *
 * ```
 * '' 兜底 → 界面显示「未命名内容」 —— 这是在**断言"这件内容没有标题"**,
 *          而实际上可能只是我们没读到。方案 §14.2 明令禁止把读失败画成没有数据。
 * 干脆不画 → 那一行标题位空着,看起来像坏了(同 `ExplorePage` 那条"不能显示空白")
 * ```
 *
 * 所以"确实没有"和"不知道"必须是**两个不同的状态** —— 与 `usePreviews`
 * 那三态是同一条纪律的第二次应用(那里的"不知道"是"什么都不能画",
 * 因为代价是白签一次名;这里的代价小得多,是"不能乱说话")。
 */
export type RowTitle =
  /** 服务端 KV 里那一份。**买家在广场上看到的就是这个** —— 所以它优先 */
  | { k: 'server'; text: string }
  /** 服务端没有(或读不到),但本机记得 —— 换台电脑就没有了 */
  | { k: 'local'; text: string }
  /** 服务端那份**读到了**,而它说这件内容没有标题。这是**真的没有** */
  | { k: 'none' }
  /** 服务端那份**还在路上**。⚠️ 与"读不到"不是一回事,见下 */
  | { k: 'pending' }
  /** **不知道** —— 读失败,或者它在服务端那份列表里根本没有(见下) */
  | { k: 'unknown' }

/**
 * 把两个来源收敛成一个状态。
 *
 * 优先级是 **服务端 KV → 本机 → 没有 → 不知道**,三点理由:
 *
 * 1. **服务端那份是买家看到的那份。** 两边不一致时,让创作者看到买家的视角
 *    才是对的 —— 否则又造出一次"看板和广场对不上",而这次是两个界面
 *    各说各话。
 * 2. **本机那份是兜底,不是主源。** 它救的是两种真实情况:`publishContentTitle`
 *    因为那条 5 分钟的 `deadline` 过期而没写进 KV(见 `uploadApi.ts`),
 *    以及服务端那份读不到。
 * 3. ⚠️ **`unknown` 有两个来源,而它们共用一个说法是**有意的**:读失败
 *    (catalog 请求挂了),以及这件内容**不在 catalog 里** —— 后者是因为
 *    catalog 只收在售内容,**下架的内容永远查不到标题**(见本文件头 2026-09-26 那段)。
 *    两种情况下这一页都给不出标题,而差别(临时的?永久的?)对看标题的人
 *    没有意义。
 *
 * ⚠️ **`pending` 不和 `unknown` 合并**:`usePreviews` 那边合并是因为
 * 代价是"白签一次名",而这里合并的代价是**闪一下假话** —— 标题先显示
 * "读不到"、半秒后变成真标题。那是"这一页会自己改口",比慢一点糟。
 */
export function resolveTitle(args: {
  contentId: Hex
  /**
   * 服务端那份标题表(键**小写**)。
   * `null` = 整份拿不到;`Map` 里某个 contentId 对应 `null` = 服务端说它没有标题
   */
  serverTitles: Map<string, string | null> | null
  /** 服务端那份**还在路上**吗 —— 与"读不到"是两回事 */
  serverPending: boolean
  /** 本机记得的那份(键小写) */
  localTitles: Map<string, string>
}): RowTitle {
  const { contentId, serverTitles, serverPending, localTitles } = args
  const id = contentId.toLowerCase()

  const fromServer = serverTitles?.get(id)
  if (fromServer) return { k: 'server', text: fromServer }

  const fromLocal = localTitles.get(id)
  if (fromLocal) return { k: 'local', text: fromLocal }

  if (serverTitles) {
    // 那份列表读到了:它在里面(且没有标题)= 真的没有;不在里面 = 目录不收它
    return serverTitles.has(id) ? { k: 'none' } : { k: 'unknown' }
  }
  return serverPending ? { k: 'pending' } : { k: 'unknown' }
}

/**
 * 那个状态能不能给出一段真的标题文字。给不出来时是 `null` ——
 * 不是空串:空串会被 `?t=` 拼进链接里(`?t=`),而"没有标题"不该改链接的形状。
 *
 * 用于两处:渲染标题`?t=` 分享参数。
 */
export function titleText(t: RowTitle): string | null {
  return t.k === 'server' || t.k === 'local' ? t.text : null
}
