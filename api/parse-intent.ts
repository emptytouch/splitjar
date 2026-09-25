import { errorResponse } from '../shared/api.js'
import {
  MAX_QUERY_LENGTH,
  type DegradeReason,
  type IntentParseResult,
  sanitizeIntent,
} from '../shared/intent.js'
import { serverEnv } from '../server/env.js'

/**
 * `POST /api/parse-intent` —— 把用户说的一句话解析成筛选条件(W14 包 A)。
 *
 * ## ⚠️ 这不是 agent,别写成 agent
 *
 * 它做的是**一次意图解析**:一句话 → `{keyword, minPrice, maxPrice, limit}`。
 * 不决定买什么、不碰私钥、不发起交易、看不到目录。
 * 「自主购买」是包 B(W15),**那个还没开工**。文案上不许含糊(计划 §3.2 / §七.5)
 * —— 把这个说成"我实现了一个 agent"是夸大,而这个仓库的判据是"每句话都要有依据"。
 *
 * ## ⭐ 这个端点**永远回 200**(计划 §9.1)
 *
 * 「没配 key」和「模型挂了」都走 `{kind:'degraded'}` —— 因为对界面来说它们是
 * **同一件事**:换成手动筛选。前端只看 `kind`,不看 `reason`(那是给排查用的)。
 *
 * ⚠️ 唯一例外是**请求本身不成形**(畸形 JSON / 缺 `query` / 超长)⇒ 400。
 * 那不是"降级",是调用方写错了,回 200 会让这种 bug 永远查不出来。
 *
 * ## ⚠️⚠️ 已知缺口:这条端点**没有限流**,而它每次调用都要花钱
 *
 * 如实记(不掩盖):这是一条公开端点,每个请求都会打一次模型 API(智谱 GLM)。
 * 仓库里**没有**现成的限流件 —— `server/kv.ts:139` 那句注释写明"真正要限流
 * 得靠 W6 的限额三件套",而那三件套没有建。
 *
 * 当前**在做的**只有三件便宜的防护:
 *
 * | 防护 | 值 | 挡什么 |
 * |---|---|---|
 * | 输入长度上限 | `MAX_QUERY_LENGTH`(200 字) | 别拿 1MB 的 body 去换 token |
 * | 输出上限 | `max_tokens: 256` | 结构化输出就四个字段,给多了是白送 |
 * | 超时 | `LLM_TIMEOUT_MS`(6s) | 挂死的上游把 function 一起拖死 |
 *
 * **挡不住**的是"有人循环调它"。演示量级可以接受,但它是一条**有成本的公开
 * 端点**,部署到公开环境前该给它配限流(按 IP 的 KV 计数就够,十几行)。
 * 这条缺口记在 `docs/W14-实施计划.md` §9.2,不在本次范围内。
 *
 * ## 为什么超时是 6 秒(而不是更久)
 *
 * `vercel.json` 里没有 `functions.maxDuration`,所以函数吃平台的**默认上限**
 * (10s 这一档)。超时必须**先于**平台把函数杀掉 —— 否则用户看到的是一个
 * 504,而**降级路径根本来不及跑**,§3.4 那条「拔掉 key ⇒ 退化成搜索框」
 * 会在"模型慢"这一支上失效。6s 留出了足够余量。
 */
/**
 * ⚠️ **具名 `POST`,不是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名,
 * 返回值直接丢掉 —— 症状是请求挂住不响应(不是报错)。见 `api/health.ts` 上那段。
 */
export async function POST(request: Request): Promise<Response> {
  // 请求体是客户端可控的,畸形 JSON 会让 `request.json()` 抛 → 必须包起来
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse(400, 'bad_request', '请求体不是合法 JSON')
  }

  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).query : undefined
  if (typeof raw !== 'string') {
    return errorResponse(400, 'bad_request', '缺少 query')
  }
  const query = raw.trim()
  if (query === '') {
    return errorResponse(400, 'bad_request', 'query 不能为空')
  }
  // ⚠️ 超长**拒掉而不是截断**:截断会让用户以为整句话都被理解了。
  // 见文件头那条"输入长度上限"—— 这道检查同时是成本防护
  if (query.length > MAX_QUERY_LENGTH) {
    return errorResponse(400, 'bad_request', `query 最长 ${MAX_QUERY_LENGTH} 个字`)
  }

  const apiKey = serverEnv('INTENT_LLM_API_KEY')
  if (!apiKey) {
    // 没配 key ⇒ 降级。**不是错误**:计划 §3.2 要求"没有它系统必须照常可用"
    // (所以它在 `server/env.ts` 里是 `required: false`)
    return degraded('not_configured')
  }

  let payload: unknown
  try {
    const res = await fetch(INTENT_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: INTENT_MODEL,
        max_tokens: 256,
        // 0 —— 这是解析,不是创作。同一个句子应当稳定地翻译成同一组条件
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: query }],
        tools: [INTENT_TOOL],
        // ⚠️ **强制**调用这个工具。不这样写,模型有可能只回一句"好的"
        // (文本),而那正是"解析不出来但要靠正则去捞 JSON"的开端 —— 别走那条路
        tool_choice: { type: 'tool', name: INTENT_TOOL.name },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })

    if (!res.ok) {
      // ⚠️ **只记状态码,不记响应体,也不记用户的 query。**
      // 这是一条公开端点,把任意用户文本灌进日志是白白送出去的一个入口。
      console.error('[parse-intent] 上游非 2xx:', res.status)
      return degraded('llm_unavailable')
    }

    payload = await res.json()
  } catch (error) {
    // 网络、超时、body 不是 JSON —— 都归到"调不通"
    console.error('[parse-intent] 调用失败:', error instanceof Error ? error.name : 'unknown')
    return degraded('llm_unavailable')
  }

  const input = readToolInput(payload)
  if (input === null) {
    // 调通了但没给工具调用 ⇒ 形状不对。与"调不通"分开记,因为排查方向完全不同
    console.error('[parse-intent] 响应里没有 tool_use 块')
    return degraded('unparseable')
  }

  return Response.json({ kind: 'parsed', intent: sanitizeIntent(input) } satisfies IntentParseResult)
}

/**
 * ⚠️ **只提供 POST。** 这条端点要带 body,`GET` 收不到 query 文本。
 * (与 `api/content-meta.ts` 同一个形状:回 405 而不是 404,让"方法用错"
 * 和"端点不存在"能分开。)
 */
export function GET(): Response {
  return errorResponse(405, 'bad_request', '这个端点只接受 POST')
}

/* ───────────────────────── 上游调用 ───────────────────────── */

/**
 * 模型名 —— 写死在这里,**不做成环境变量**。
 *
 * 它是"当时定下来的一个决定",不是部署差异。做成环境变量只会多一个能配错、
 * 还不报错的地方。
 *
 * ⚠️ **注意这个不对称是有意的**:密钥走环境变量(`INTENT_LLM_API_KEY`),
 * 而模型名写死在代码里。理由是两者变动的**时机**不同 —— 密钥是"每套部署
 * 各自一份",必须能配;模型是"我们要它用哪个",改它应该是一次**被 review 的
 * 代码改动**,而不是某天有人在控制台里打错一个字,然后所有解析悄悄变差。
 */
const INTENT_MODEL = 'glm-5.3'

/** ⚠️ 6 秒的**理由**见文件头 —— 它必须比平台默认的函数上限先到 */
const LLM_TIMEOUT_MS = 6_000

/**
 * ⚠️⚠️ **这是智谱的 Anthropic *兼容* 端点,不是 Anthropic 的端点。**
 *
 * ```
 * https://open.bigmodel.cn/api/anthropic/v1/messages
 * ```
 *
 * 2026-09-26 从 `https://api.anthropic.com/v1/messages` 换过来(计划 §9.4)。
 * 换它的**理由**是这一跳只做四字段抽取,而输入是中文;智谱的 key 也更好拿。
 *
 * ⭐ **整个文件里只有这两个常量 + 上面那个模型名是"厂商相关"的** ——
 * 请求头(`x-api-key` / `anthropic-version`)、请求体的字段名、以及
 * `readToolInput` 从 `content` 数组里取块的写法,兼容端点全都认,
 * **一行都没改**。这就是当初选"兼容端点"而不是"换成另一家的原生协议"的意义:
 * 真要换的只有地址和型号。
 *
 * ⚠️ **换过来之后有一件事必须实测,不能靠推断**:`tool_choice: {type:'tool'}`
 * 这种**强制**工具调用,是兼容层最容易打折的地方。若它不生效,症状是模型
 * 回一段文本而 `content` 里没有 `tool_use` 块 ⇒ `readToolInput` 返回 `null`
 * ⇒ 回 `unparseable` ⇒ **前端降级成手动筛选**。**失败方式是降级,不是崩**,
 * 所以试错成本很低 —— 但这不等于"验过了"。
 */
const INTENT_MESSAGES_URL = 'https://open.bigmodel.cn/api/anthropic/v1/messages'

/**
 * ⚠️ 名字保留 `ANTHROPIC_` 前缀,因为**那个 HTTP 头就叫 `anthropic-version`** ——
 * 它描述的是**线上协议**,不是厂商。兼容端点也认这个值。
 */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 系统提示词。三条纪律各对应一个真实会发生的坏结果:
 *
 * - **不要发明条件** —— 否则用户说「看看有什么」会被塞进一个关键词,然后
 *   界面显示"没找到"。他会以为目录是空的
 * - **不做单位换算** —— 见 `shared/filterContents.ts` 文件头
 * - **不要猜目录里有什么** —— 它看不到目录;让它"推测"就等于让它编
 */
const SYSTEM_PROMPT = `你在帮一个内容市场把买家说的一句话翻译成筛选条件。

市场里的商品是链上注册的付费内容,每件只有:标题(可能没有)、价格(USDC 计价)、创作者地址、预览图(可能有)。没有分类、没有标签、没有描述。

请把用户的话翻译成这四项,**只填他话里真的说了的**:
- keyword:关键词,用于匹配标题。只填他提到的**东西或类型**本身(如「图」「苹果」),不要填修饰语。
- minPrice / maxPrice:价格区间,**十进制字符串**(如 "0.5")。「0.5 以下」⇒ maxPrice="0.5";「1 块以上」⇒ minPrice="1";「0.5 到 1 之间」⇒ 两个都填。
- limit:最多几件,整数。「给我三个」⇒ 3。

三条纪律:
1. **不要发明条件。** 他没提价格就别填价格,没提关键词就别填关键词。四项全空是**合法**的(他说「看看有什么」时就是这样)。
2. **价格填他说的那个数,不做任何单位换算。** 他说 0.5 你就填 "0.5"。
3. **不要猜测市场里有什么。** 你看不到目录,任何"推测"都是编造。`

/**
 * 工具定义 —— 用**强制工具调用**拿结构化输出,而不是"求模型回 JSON 再正则去捞"。
 *
 * ⚠️ `required: []` **是刻意的**:四项一项都不设为必填。因为"用户没提到价格"
 * 必须能表达成"这个字段干脆不来",而 JSON Schema 里没有干净的方式表达
 * "字符串或 null";设成必填会逼模型硬凑一个值 —— 那就是纪律 1 的反面。
 */
const INTENT_TOOL = {
  name: 'set_search_intent',
  description: '记录从用户那句话里解析出来的筛选条件。用户没提到的项就不要传。',
  input_schema: {
    type: 'object' as const,
    properties: {
      keyword: { type: 'string' as const, description: '关键词,用于匹配商品标题' },
      minPrice: { type: 'string' as const, description: '最低价,USDC 十进制字符串,如 "0.5"' },
      maxPrice: { type: 'string' as const, description: '最高价,USDC 十进制字符串,如 "0.5"' },
      limit: { type: 'integer' as const, description: '最多几件' },
    },
    required: [] as string[],
  },
}

/**
 * 从 Messages API 的响应里取出工具调用的入参。
 *
 * ⚠️ **认 `type`,不认位置。** 别写 `content[0].input` —— 响应的 `content`
 * 是一个块数组,`text` 块和 `tool_use` 块都可能出现,顺序也不保证。
 */
function readToolInput(payload: unknown): unknown | null {
  if (typeof payload !== 'object' || payload === null) return null
  const content = (payload as { content?: unknown }).content
  if (!Array.isArray(content)) return null

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; name?: unknown; input?: unknown }
    if (b.type === 'tool_use' && b.name === INTENT_TOOL.name) return b.input ?? {}
  }

  return null
}

/**
 * 降级响应 —— 与 `parsed` **同为 200**。
 *
 * ⚠️ 三种原因在界面上是同一件事,前端**只看 `kind`**(计划 §9.1)。
 * 这里保留 `reason` 是为了排查:界面换成手动筛选之后,总得有人能回答
 * "它为什么换了" —— `/api/health` 只看得出"key 配没配",看不出"超时了没有"。
 */
function degraded(reason: DegradeReason): Response {
  return Response.json({ kind: 'degraded', reason } satisfies IntentParseResult)
}
