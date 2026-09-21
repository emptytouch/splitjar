import type { Hex } from 'viem'

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
 * 但那要先有真实 Vercel 部署 + 开通 KV,属于 W8。**W5/W8 再把它落地。**
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
 * 标题**只用于展示**,所以这里做的是转义而不是校验。
 *
 * 长度截断是必须的:标题直接进 URL,不限制的话一个几千字的标题
 * 会让二维码密到扫不出来 —— 而二维码正是付费页的主要入口。
 */
export const TITLE_MAX = 40

export function normalizeTitle(raw: string): string {
  return raw.trim().slice(0, TITLE_MAX)
}

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
