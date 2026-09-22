import { CHAIN, ESTIMATED_PAY_GAS, WALLET_DEFAULT_TIP } from '../../shared/chain'
import type { BlockReason } from './payMachine'

/**
 * 付费页的**闸门** —— 把「这个钱包现在能不能买这份内容」算成一个**纯函数**。
 *
 * ## 为什么必须有这个文件(2026-09-23)
 *
 * 这套判断原先只写在 `usePayFlow` 的校验 effect 里,而那个 effect 的入口是
 * `if (state.k !== 'checking') return` —— 也就是说**它只在用户点过付款之后才跑**。
 * 首屏是 `idle`,判断一次都没执行,于是:
 *
 * - 已经买过的人打开链接,看到的是一个「付款 0.05 USDC」按钮
 * - 余额不够、内容已下架,同理 —— 全都要先点一下才告诉他
 *
 * 而 `payMachine.ts` 自己的注释写着「让用户签完名才告诉他'你早买过了'是在
 * 浪费他的时间和 gas」,`splitter.ts` 里那个从没被用过的 `ContentGate` 类型
 * 写着「付费页**首屏**要同时判断'存在 / 已下架 / 我买没买过'」——
 * **意图和实现在这里岔开了。**
 *
 * 修法是把这个函数抽出来,**渲染和校验 effect 共用同一份**。
 * 两处各写一遍同一套条件,迟早会漂移,而漂移的表现就是
 * "首屏说能买、点下去说不能" —— 比现在这个 bug 更难查。
 *
 * ## 三种结果,不是两种
 *
 * `pending` 是**独立于** blocked/open 的第三种状态,不能和 open 合并:
 * 数据没读齐时放行 = 首屏短暂显示付款按钮再翻脸;数据没读齐时拦下 =
 * 无中生有一个错误。**"还没结论"必须能被表达出来。**
 */

/**
 * AVAX 预检要留的余量 —— 比 `pay` 贵得多的是 approve + pay 两笔。
 *
 * 按**钱包实付口径**算(1 nAVAX),不是节点建议价。节点报 160 wei,
 * 差 600 万倍 —— 用错口径算出来的"余额够"是假的。
 * 这正是 ChainProbe 当初踩过的坑,见 `shared/chain.ts` 的 `WALLET_DEFAULT_TIP` 注释。
 */
export function avaxNeeded(needsApprove: boolean): bigint {
  const txCount = needsApprove ? 2n : 1n
  return ESTIMATED_PAY_GAS * txCount * WALLET_DEFAULT_TIP
}

export type GateInput = {
  contentId: string | null
  isConnected: boolean
  address: string | undefined
  chainId: number | undefined
  /** 所有链上读都已出结果 —— 没有任何一个还在 loading */
  readsSettled: boolean
  exists: boolean | undefined
  existsError: boolean
  contentError: boolean
  /** `getContent` 的数据到了没有(价格也来自它) */
  contentArrived: boolean
  active: boolean | undefined
  /**
   * `true` 买过 / `false` 明确没买过 / `undefined` 读失败(或还没读,但那种
   * 情况会被 `readsSettled` 先拦下)。
   *
   * ⚠️ **这里不需要单独的 `ownedError`** —— 判据是 `owned !== false`(见下),
   * 「读失败」和「读到一个 undefined」在这个判据里是同一件事,都得拦。
   * 加一个 error 字段只会诱使后来的人写成 `if (ownedError) 放过`,那正好是反的。
   */
  owned: boolean | undefined
  price: bigint | undefined
  usdc: bigint | undefined
  allowance: bigint | undefined
  avaxWei: bigint | undefined
}

export type GateResult =
  /** 数据还没齐,现在下任何结论都是猜 —— 调用方应保持现状(首屏继续骨架屏) */
  | { k: 'pending' }
  /** 拦下,且**还没签名**,用户没白花任何东西 */
  | { k: 'blocked'; reason: BlockReason }
  /** 可以买。`needsApprove` 决定要走一笔还是两笔 */
  | { k: 'open'; needsApprove: boolean }

/**
 * 判断顺序**照抄原来那个 effect**,加了一条 `ownership-unknown`。
 *
 * ⚠️ **2026-09-23 有一处**不是照抄,是**故意改的**:归属(③)从下架(④)的
 * **后面**挪到了**前面** —— 因为"下架不影响已购"是产品语义,而原来的顺序
 * 会让买过的人在下架后失去下载入口。理由写在 ③④ 之间的注释里,别改回去。
 *
 * 顺序本身是有意义的:越靠前的越省事、越不需要等数据。但③④这一处不是
 * "省事"排序,是**语义**排序 —— 先问"这东西是不是你的",再问"它还在不在卖"。
 */
export function evaluateGate(i: GateInput): GateResult {
  // ① 不需要任何链上数据就能判的
  if (!i.contentId) return { k: 'blocked', reason: 'content-not-found' }
  if (!i.isConnected || !i.address) return { k: 'blocked', reason: 'wallet-not-connected' }
  if (i.chainId !== CHAIN.id) return { k: 'blocked', reason: 'wrong-chain' }

  // ② 从这里开始都要看链上数据。没读齐就不下结论(见文件头「三种结果」)
  if (!i.readsSettled) return { k: 'pending' }

  if (i.existsError || i.exists !== true) return { k: 'blocked', reason: 'content-not-found' }
  if (i.contentError) return { k: 'blocked', reason: 'content-not-found' }
  if (!i.contentArrived || i.price === undefined) return { k: 'pending' }

  // ③ 归属 —— **fail-closed:只有明确读到 `false` 才放行**
  //
  // ⚠️ 这一条是这次顺带补上的洞。原来的写法是 `if (owned.data === true) 拦下`,
  // 于是「读失败」和「没买过」落进同一个分支 —— 一次 RPC 抖动就会让页面
  // 去推销用户**已经拥有**的东西。
  //
  // 同文件里的另外两个读方向是对的:`usdcBalance` 读失败当成 0 → 「余额不足」
  // (拦住,安全);`allowance` 读失败当成 0 → 多走一次 approve(无害)。
  // 只有归属这一个,错了会朝**危险的**那一边倒,所以它必须显式判 `false`。
  //
  // 这不只是理论问题:合约里第二次 `pay()` 会 revert `AlreadyPurchased`,
  // 所以钱不会丢 —— 但用户会被引导去签一笔注定失败、白花 gas 的交易。
  //
  // ⚠️⚠️ **归属必须排在下架前面**(2026-09-23 换位,原因见下一条)。
  if (i.owned === true) return { k: 'blocked', reason: 'already-purchased' }
  if (i.owned !== false) return { k: 'blocked', reason: 'ownership-unknown' }

  // ④ 下架 —— **必须排在归属之后**,这是产品语义,不是排序偏好
  //
  // 需求原话:「下架的内容,**不影响已付款,继续下载**」。
  //
  // 服务端那半已经是对的:`api/unlock.ts` 的六道检查里没有任何一步看
  // `active`,只有 `hasPurchased` —— 所以签名换 URL 这条路对已下架内容
  // 照常放行,是**故意**的。
  //
  // 但如果这一条排在归属前面(2026-09-23 之前就是),一个**买过之后**
  // 内容被下架的人会先命中 `content-inactive`,而 `describeBlock` 给它的
  // 出路是 `recovery: { k: 'none' }` —— **一个付过钱的人连下载按钮都没有**。
  // 最能说明问题的是那段文案自己:它写着「如果你之前买过仍可下载」,
  // 却只给了一个死路。承诺和 UI 对不上。
  //
  // ⚠️ `ownership-unknown`(上一条)放在它前面也是**有意的**,不是顺手:
  // 若把它留在后面,「已下架 + 归属读失败」会落到这条死路 —— 而那个用户
  // **可能真的买过**。死路对他比"重试"更糟:他没有任何办法拿回自己买的东西。
  // 所以顺序是「先问是谁的,再问还在不在卖」—— 反过来就会误伤已购用户。
  //
  // 到这里能走到这一条的,只剩「明确读到 `owned === false`」的人 ——
  // 真正的、还没买过的访客。拦他们是对的。
  if (i.active !== true) return { k: 'blocked', reason: 'content-inactive' }

  // ⑤ 付得起吗
  if ((i.usdc ?? 0n) < i.price) return { k: 'blocked', reason: 'insufficient-usdc' }

  const needsApprove = (i.allowance ?? 0n) < i.price
  if ((i.avaxWei ?? 0n) < avaxNeeded(needsApprove)) {
    return { k: 'blocked', reason: 'insufficient-avax' }
  }

  return { k: 'open', needsApprove }
}
