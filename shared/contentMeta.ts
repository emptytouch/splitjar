/**
 * 标题的**规范化与长度上限** —— 前端填、服务端存,所以两端共用这一份。
 *
 * ## ⚠️ 2026-09-23(W7)从 `src/lib/contentMeta.ts` 拆出来
 *
 * 原来 `TITLE_MAX` / `normalizeTitle` 只在浏览器里用(创建页截断 + 拼分享链接)。
 * W7 加了 `POST /api/content-meta`,服务端在**写进 KV 之前**也要按同一套规则
 * 规范化 —— 而服务端**不能 import `src/lib/`**(那份代码带着 `window`,
 * 而且 `tsconfig.api.json` 不带 DOM,一 import 就编译不过)。
 *
 * 拆成"纯规则进 `shared/`、带 `window` 的留在 `src/lib/`"是唯一能两端共用的切法。
 * 浏览器那一侧(`buildShareUrl` / `rememberContent` 等)仍在 `src/lib/contentMeta.ts`。
 *
 * ## 为什么服务端也要截断,而不是"信前端传上来的"
 *
 * 因为**服务端不能信客户端**。前端截到 40 只是界面上的 maxLength,
 * 任何人手打一个 POST 都能塞进一个 10 万字的标题 —— 那个标题会被
 * **所有 agent 的 catalog 响应**读到(方案 §9.4 的 `GET /api/catalog` 直接返回它),
 * 等于给了一个往别人响应里灌数据的位置。
 */

/**
 * 标题字符数上限。
 *
 * 前端那一侧的理由(37 个字以上的标题会让分享二维码密到扫不出来)仍然成立;
 * 服务端这一侧的理由见文件头 —— 防止有人在 catalog 响应里塞垃圾。
 */
export const TITLE_MAX = 40

/**
 * 规范化:去首尾空白 + 截断。
 *
 * ⚠️ **行为与拆分之前逐字一致**(`trim().slice(0, TITLE_MAX)`),没有顺手"改进"。
 * 理由:它已经在跑,而且创建页的 `<input maxLength={TITLE_MAX}>` 是按
 * **UTF-16 码元**计数的 —— 改成按码点切会让 JS 与那个 HTML 属性对同一个
 * 标题给出不同的长度判断,行为改动不在本包范围内。
 *
 * ⚠️ **已知限制(记录,不修)**:`slice` 按 UTF-16 码元切,会在一个占两个码元的
 * 字符(emoji、部分罕见汉字)上**从中间劈开**,产出一个孤立代理项。
 * 后果是分享链接里那个字渲染成方块,以及它进 JSON 时是一个合法但无意义的字符串。
 * **没有安全后果,也不影响付费与分账**(标题不参与任何校验)。
 * 真要修,得连 `maxLength` 一起改成按码点算,那是一次独立的前端改动。
 *
 * ⚠️ 截断**不**做 Unicode 归一化(NFC/NFD)。看起来一样但码点不同的两个标题
 * 会被当成不同字符串 —— 同样没有安全后果(标题不参与任何比较)。
 */
export function normalizeTitle(raw: string): string {
  return raw.trim().slice(0, TITLE_MAX)
}
