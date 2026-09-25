import { USDC } from './chain.js'
import { KEYWORD_MAX_LENGTH, normalizeKeyword, normalizeLimit } from './filterContents.js'
import { formatUsdc, parseUsdc } from './units.js'

/**
 * 「一句话 → 筛选条件」的**线上形状**(W14 包 A)。
 *
 * ## ⚠️ 这里没有 agent
 *
 * 这一层做的事情只有一件:**把用户说的一句话翻译成三个框里该填什么**。
 * 它不决定买什么、不碰私钥、不发起交易。文案上不许写成"我实现了一个 agent"
 * —— 那是自主决策,这是意图解析(计划 §3.2 / §七.5)。
 *
 * ## ⚠️ 价格用**人说的话**,不用原始单位
 *
 * 用户说「0.5 以下」,模型就输出 `"0.5"`。**不让模型算 `×10⁶`**:
 * 算错的症状是"筛出来的东西不对",不报错。换算只发生在 `parseUsdc` 一处
 * (理由见 `shared/filterContents.ts` 文件头)。
 *
 * ## ⚠️ 文件名叫 intent 而不是 parse —— 因为类型两端都要用
 *
 * `api/parse-intent.ts` 是那条 HTTP 端点;这里住的是**它回什么形状**。
 * 前端要按 `kind` 分支(计划 §9.1),所以这份定义必须在 `shared/`。
 */

/** 一句话的**长度上限**,超了直接 400 —— 这是一条公开端点,输入不是白来的 */
export const MAX_QUERY_LENGTH = 200

/**
 * 解析出来的查询。**四个字段都可能为 `null`** —— 那表示"这一项没提到",
 * 不表示"这一项解析失败"。
 *
 * ⚠️ 四个全 `null` 是**合法结果**,不是失败:用户说「看看有什么」时,
 * 正确答案就是"什么都不筛"。这时候界面上说的是
 * 「没有提取到具体条件 —— 下面是全部在售内容」,**不是**降级。
 * (这一点容易写反:把"没提取到条件"当成"解析失败",然后去说一句
 *  "智能解析不可用" —— 而模型其实干得好好的。)
 */
export type SearchIntent = {
  /** 关键词,匹配标题。`null` = 没提到 */
  keyword: string | null
  /** 人可读的 USDC 小数,如 `"0.5"`。`null` = 没提到 */
  minPrice: string | null
  /** 同上,上限 */
  maxPrice: string | null
  /** 最多几件 */
  limit: number | null
}

/** 为什么会降级。**只用于服务端日志/排查,前端不许按它分支**(见下) */
export type DegradeReason =
  /** 服务端没配 `INTENT_LLM_API_KEY` */
  | 'not_configured'
  /** 调不通:网络、超时、非 200 */
  | 'llm_unavailable'
  /** 调通了,但回的东西不成形状 */
  | 'unparseable'

/**
 * `POST /api/parse-intent` 的响应。
 *
 * ⚠️ **`kind` 是前端唯一能分支的东西**(计划 §9.1)。加这个判别联合的理由是
 * "前端不猜原因":降级的三种原因在界面上是**同一件事**(换成手动筛选),
 * 让前端去区分它们只会多一层会漂移的翻译。
 * `reason` 留在体里是给**排查**用的 —— 它同时也在 `/api/health` 的
 * `configured` 那一列里可见,不构成新的信息泄露。
 */
export type IntentParseResult =
  | { kind: 'parsed'; intent: SearchIntent }
  | { kind: 'degraded'; reason: DegradeReason }

/**
 * 校验并归一模型吐出来的东西 —— **永远不信任它**。
 *
 * ## ⚠️ 为什么校验必须在这里、而不是靠工具调用的 schema
 *
 * 工具调用的 JSON Schema 是**给模型看的提示**,不是服务端的强制。
 * 真正进到 `input` 里的东西仍然是"一个 JSON 对象",可能有:
 * 多余字段、`limit: 0`、`maxPrice: 0.5`(数字不是字符串)、
 * 或者一个 500 字的关键词。所以这里逐项过一遍。
 *
 * ## ⚠️ 单项坏掉**不掀桌子**
 *
 * 价格形状不对时丢**那一项**、保留别的,而不是整个判成 `unparseable`。
 * 理由是界面上会**回显**最终采纳的条件(`describeFilter`)——
 * 丢掉的项在回显里就是"没有这个条件",用户看得见。
 * 反过来把关键词一起丢掉,才是真的把一次成功的解析浪费掉了。
 */
export function sanitizeIntent(raw: unknown): SearchIntent {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  return {
    keyword: sanitizeKeyword(obj.keyword),
    minPrice: sanitizePrice(obj.minPrice),
    maxPrice: sanitizePrice(obj.maxPrice),
    limit: normalizeLimit(obj.limit),
  }
}

function sanitizeKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // ⚠️ 复用 `normalizeKeyword`(去空白 + 砍到 `KEYWORD_MAX_LENGTH`)——
  // 界面上的手动关键词框走的是同一个函数,两条路的"关键词"必须同义
  return normalizeKeyword(raw)
}

/**
 * 价格:只认**十进制字符串**(`"0.5"`),再顺手接住模型偶发的数字字面量。
 *
 * `parseUsdc` 会拒掉科学计数法、超精度、负号这些;它一抛,这一项就是 `null`。
 * 这里**不改写成 0** —— 0 是一个真实的价格上限("≤ 0 USDC"),会把结果筛空,
 * 而用户看到的是"没找到",像一个正常的结果。
 */
function sanitizePrice(raw: unknown): string | null {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null
  if (s === null || s === '') return null

  try {
    // 来回一趟:过了 `parseUsdc` 才算数,再 `formatUsdc` 成规范写法
    // (`"0.50"` → `"0.5"`)。这样**回显出来的**和**拿去筛的**是同一个字符串,
    // 不会出现"框里写着 0.50、实际按 0.5 筛"这种对不上的情况
    return formatUsdc(parseUsdc(s, USDC.decimals), USDC.decimals)
  } catch {
    return null
  }
}

/** 关键词上限 —— 转出去给前端做输入框的 `maxLength`,别让两边各记一个数 */
export { KEYWORD_MAX_LENGTH }
