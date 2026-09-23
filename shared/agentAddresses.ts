import { getAddress, isAddress, type Address } from 'viem'
import whitelist from './agentAddresses.json'

/**
 * 「谁是 agent」—— **唯一来源**,数据在 `./agentAddresses.json`。
 *
 * ## ⚠️ 先接受一件事:这不是"识别",是"登记"
 *
 * 链上**没有** agent 的痕迹。人类和 agent 走的是**同一个** `pay(bytes32)`、
 * 发的是**同一个** `PaymentSplit` 事件,而且合约里 `msg.sender` **就是买家本人**
 * (我们**故意**不实现 x402 的 facilitator 代付 —— 见 `shared/agentPay.ts` 文件头)。
 * 连"有人代发"这个区别都不存在。
 *
 * 剩下的链上特征(nonce 节奏、gas 价格、有没有先 `approve`)全是**启发式**:
 * 可伪造,而且会把"用脚本的老手"误判成 agent。**「是不是 agent」不是系统的属性,
 * 是客户端的属性** —— 一个脚本后面可能坐着人,一个人也可能 `curl`。
 *
 * 所以本模块**只做登记**:名单里有就是 agent,没有就不是。
 * **任何 UI 上关于它的说法都只能写成「按地址白名单判定」,不能写成"自动识别"。**
 * 完整推演见 `docs/W8-实施计划.md` §〇。
 *
 * ## 为什么放在 `shared/`
 *
 * 前端看板要用它(给 `PaymentSplit.payer` 打 `[Agent]` 徽章),演示脚本也要用它
 * (自检「我用来付款的地址,是不是被看板标成 agent」)。
 * **两处读同一份**是刻意的 —— 各写一份的话,"脚本付的地址"和"看板标的地址"
 * 会各自漂移,而漂移的症状是**看板把 agent 标成人类**,且**不报错**。
 * 那等于把一条验收项交给"记得同步"。
 *
 * 准入条件同 `./contentActive.ts` 的理由:纯数据 + 纯函数,不碰 DOM、不碰 React、
 * 不碰 wagmi、不碰 `node:*`,所以两端都能用(见 README「四条边界」)。
 */

/** JSON 里一条记录的形状 */
type RawEntry = {
  address: string
  label?: string
}

/** 归一化之后给人的形状 */
export type AgentEntry = {
  /** checksum 形态。**存下来的是归一化后的值**,免得每个使用方各转一次 */
  address: Address
  /** 只给人看的一句话;没写就是空串(不是 `undefined`,省掉使用方的 `?? ''`) */
  label: string
}

/**
 * 读名单并把地址归一化成 checksum。
 *
 * ## ⚠️ 这里**故意抛异常**,而不是"跳过不合法的条目"
 *
 * 一个写错的地址如果被悄悄跳过,后果是:**看板把那个 agent 标成人类,不报错**
 * —— 正是本文件头说的那个"没有声音的失败"。而它同时会挂掉 §16.1 第 7 条那一屏。
 *
 * 抛出来的代价是"名单写错 = 看板打不开",听着很重,但它**立刻可见、且错误信息
 * 直接指名文件和那一条的值**,修好就是一行。**响亮地坏掉比安静地错好。**
 * (这份名单只有个位数条目、改动极低频,不存在"为了韧性要容错"的场景。)
 *
 * 📌 归一化的**必要性**:`PaymentSplit` 事件的 `payer` 是 `indexed`,viem 解出来是
 * **checksum 形态**;而人手写进 JSON 的很可能是**全小写**。不归一化直接比,
 * 会**静默地永不命中**。`shared/agentPay.ts` 的 `parseXPayment` 对 `payer` 做的是
 * 同一件事,理由一模一样。
 */
function normalizeEntries(entries: RawEntry[]): AgentEntry[] {
  return entries.map((entry, i) => {
    // 用可选链兜住 `null` / 少一个字的条目 —— JSON 是运行时读的,TS 的类型在这里拦不住
    const raw = (entry as RawEntry | null)?.address
    if (typeof raw !== 'string' || !isAddress(raw)) {
      throw new Error(
        `shared/agentAddresses.json 的 agents[${i}] 不是合法地址:` +
          `${JSON.stringify(raw)}。` +
          `这份名单决定看板给谁打 [Agent] 徽章,写错一个字符不会报错、` +
          `只会把那个 agent 静默地标成人类,所以这里选择直接抛。`,
      )
    }
    return {
      // ⚠️ 先 `toLowerCase` 再 `getAddress`:非 strict 的 `getAddress` 会拿输入
      // 自己算 checksum 并和输入比,**全小写地址**会被它判成"校验和不符"而抛。
      // 这一步在 `parseXPayment` 里也做过,别省。
      address: getAddress(raw.toLowerCase() as Address),
      label: (entry as RawEntry | null)?.label ?? '',
    }
  })
}

/** 名单本体,按 JSON 里的顺序 */
export const AGENT_ENTRIES: readonly AgentEntry[] = normalizeEntries(
  whitelist.agents as RawEntry[],
)

/** 只要地址的那份 —— 界面上要摊开显示名单内容,拿它拼字符串用 */
export const AGENT_ADDRESSES: readonly Address[] = AGENT_ENTRIES.map((e) => e.address)

/**
 * 查表用的集合,**键是 `toLowerCase()` 之后的地址。**
 *
 * ## ⚠️ 为什么这里比的是小写串,而不是像名单那样存 checksum
 *
 * 判据是**喂进来的东西可不可信**:
 *
 * - 名单那一侧是我们自己写的、量极小,存 checksum 供人复制粘贴、也让 diff 好看;
 * - **这一侧喂进来的可能是任何东西** —— 事件参数在 viem 的类型里是可选的,
 *   运行时也可能是 `undefined`、空串、截断的地址。
 *
 * 而 `getAddress()` 对不合法的输入**会抛**。查询函数抛异常是坏设计:
 * 它把一个"这条不是 agent"变成了"整个看板挂掉",而且调用方还得包 try。
 * 小写比较对任意输入都只是 `false`,**语义与 checksum 比较完全等价**
 * (EIP-55 只影响大小写,不影响身份)。所以:只在**边界**归一化一次,
 * 查表用最不容易出错的形式。
 */
const AGENT_SET: ReadonlySet<string> = new Set(
  AGENT_ADDRESSES.map((a) => a.toLowerCase()),
)

/**
 * 这个地址在不在名单里。
 *
 * ⚠️ **判空是必须的,不是防御性编程**:调用方是
 * `AGENT_ADDRESSES.includes(log.args.payer)` 这类来自 viem 事件参数的写法,
 * 而事件里被 `indexed` 的字段在类型上是可选的(`log.args.payer` 可能是
 * `undefined`)。写成 `includes(payer!)` 就把这一层交给了一个 `!`。
 *
 * ⚠️ 名单是**空**的时候这个函数恒为 `false`,这是**正确行为**而不是 bug:
 * 还没登记过任何 agent,就不该有人被标成 agent。
 */
export function isAgentAddress(addr: string | null | undefined): boolean {
  if (!addr) return false
  return AGENT_SET.has(addr.toLowerCase())
}
