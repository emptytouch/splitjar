/**
 * 从 `ContentActiveChanged` 事件推出「每件内容**现在**在不在售」。
 *
 * ## 为什么单独一个文件
 *
 * 这段推导原先内联在 `useMyContents` 的 `queryFn` 里 —— 那样**测不了**:
 * 要验它就得连上链、还得真的把一件内容切两次。而它恰恰是最容易写错的一处:
 *
 * > **靠遍历顺序取"最后一条",顺序反了会静默地给出上一次的状态。**
 *
 * 这个 bug 的形状很坏:切一次看不出来(只有一条事件,怎么遍历都对),
 * **连着切两次才暴露,而且表现是"显示的是上上次的状态"** —— 一个看起来
 * 像随机闪烁的现象。所以必须能单独验。
 *
 * ## ⚠️ 2026-09-23(W7)从 `src/lib/contentActive.ts` **整份挪到 `shared/`**
 *
 * 因为服务端也要用它了 —— `/api/catalog` 只列在售的,`/api/content/:id` 要判下架。
 * 照抄一份到服务端就是**两份会漂移的判断**,而上面刚说过它错起来是静默的。
 *
 * 纯函数,不碰 DOM、不碰 React、不碰 wagmi,所以两端都能用 ——
 * 这正是 `shared/` 的准入条件(见 README「四条边界」)。前端那份**已删除**,
 * 别在两个地方各留一份。
 *
 * ## 依赖的两个事实(都去合约里核过,不是假设)
 *
 * 1. **初始值是 `true`** —— `CreatorSplitter.sol:172` 在注册时写死
 *    `c.active = true`。所以"没有任何变更事件"= 在售。
 *    ⚠️ 猜错这一条,一件从没改过上下架的内容会被显示成"已下架" —— 完全相反的结论。
 * 2. **每次调用都发事件**,合约里**没有**"值没变就不发"的空转保护
 *    (`CreatorSplitter.sol:184-185`)。所以"最后一条的值"确实等于当前状态,
 *    不会出现"值变了但那一次没发事件"导致的状态漂移。
 */

/** `ContentActiveChanged` 事件里我们真正要用的部分 */
export type ActiveChange = {
  contentId: string
  active: boolean
}

/**
 * 按 contentId 收敛到**最后一条**事件的 `active`。
 *
 * ⚠️ **入参必须按发生顺序**(区块升序,同区块内 logIndex 升序)——
 * viem 的 `getContractEvents` 就是这个顺序。这个函数**不做排序**:
 * 它没有区块号可用(事件里只有 contentId 和 active),只能信任调用方。
 * 所以调用方一旦换成一个不保序的来源(比如并发按 contentId 分别查再合并),
 * 这里会静静地给出错答案。测试里专门有一条覆盖"连续两次切换"。
 */
export function deriveActiveState(changes: ActiveChange[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  // 后写覆盖先写 —— 循环结束时留下的就是最后一条
  for (const c of changes) out.set(c.contentId, c.active)
  return out
}

/**
 * 某件内容的当前状态。
 *
 * 有事件时以**最后一条事件**为准;从没改过就用注册时的初始值 `true`。
 *
 * 传 `contentId` 的大小写:**一律转小写再查**。事件里的 `contentId` 是
 * 32 字节 hex,viem 解码后是小写;而 `contentId` 从别处来的时候不保证。
 * 不做这一步的话,"有些内容显示不出来"会变成一个时有时无的怪 bug。
 */
export function isActive(
  state: Map<string, boolean>,
  contentId: string,
): boolean {
  return state.get(contentId.toLowerCase()) ?? true
}
