/**
 * 把 `eth_getLogs` 的全量范围**切成窗口** —— 因为公共 RPC 对范围有上限。
 *
 * ## 为什么需要它(2026-09-24 实测到的阻塞级缺陷,详见 `docs/W8-实施计划.md` §十一)
 *
 * `shared/chain.ts` 与 `src/hooks/useMyContents.ts` 都写着同一句旧实测:
 * 「2026-09-21 实测公共 Fuji RPC **不限制 `getLogs` 范围**(10 万块一次查完也成功)」。
 *
 * **那句已经过期,而且是过期在它依赖的量上:**
 *
 * - 备端点 `avalanche-fuji-c-chain-rpc.publicnode.com` 的上限是 **50,000** 块,
 *   超了直接回 `-32701 exceed maximum block range: 50000`;
 * - 而 `DEPLOY_BLOCK` 到 `latest` 的跨度是 **158,401**(上限的 3.17 倍),
 *   且**只涨不减**。
 *
 * ⚠️ 后果不是"慢",是**主备这条假设在链上不成立**:主端点一旦不可达
 * (2026-09-24 那天它的 DNS 就是解析不了的),viem 的 `fallback` 会走到备端点,
 * 备端点抛 `RpcRequestError` —— **fallback 不会再吞它**,直接冒到调用方的 `catch`
 * 变成 503。**代码里看着有主备,实际上是一条腿。**
 *
 * ## 教训(比这次的修法更值得记)
 *
 * 凡实测依赖一个**会增长的量**,必须连**上限**一起记下来。
 * 只写"这次过了"等于没记 —— 它会把"跨度还没超上限"记成"没有上限"。
 *
 * ## 为什么是「纯函数 + 回调」,而不是一个吃 viem client 的 `scanEvents`
 *
 * 1. **类型会丢。** `getContractEvents` 的 `strict: true` 收窄**只对字面量
 *    `eventName` 生效**。包一层泛型必然把 `args` 放宽成整个 ABI 的联合类型 ——
 *    那就把 `server/chain.ts` 里「少了 `strict` 类型就废了」那段注释的收益原样丢掉。
 *    回调让每处调用点保留自己的 `abi` / `eventName` / `args`,类型一行不丢。
 * 2. **切窗口跟链无关**,是能脱离链验的 —— 与 `deriveActiveState` 同一个形状
 *    (`shared/contentActive.ts`),那是这个仓库对"最容易写错的那一处"的一贯处理。
 * 3. 两端共用一份,**不会漂移** —— 这正是 `shared/` 的准入条件(见 README「四条边界」)。
 */

/**
 * 单个窗口最多跨多少区块(含两端)。
 *
 * **是量出来的,不是抄的。**对备端点 `publicnode` 实测 `to - from`:
 *
 * | `to - from` | 结果 |
 * |---|---|
 * | 49,999(含两端 = 50,000 块) | ✅ |
 * | 50,000 | ✅ |
 * | 158,400(全量) | ✗ `-32701 exceed maximum block range: 50000` |
 *
 * 窗口按 `[from, from + size - 1]` 写,于是 `to - from = 49,999` ——
 * **卡在上限的下一格**。别把这里改成"正好等于报错里那个数字":
 * 报错里的 50,000 是 `to - from` 的口径,不是"块数"的口径,两个口径差一格。
 */
export const LOG_WINDOW_SIZE = 50_000n

/** 一个闭区间 `[from, to]`,两端都含。 */
export type BlockWindow = { from: bigint; to: bigint }

/**
 * 把一个闭区间切成若干窗口。**纯函数,不碰链。**
 *
 * 边界(每一条都有对应的验证用例,见 §11.6):
 *
 * - `from > to` → `[]`(不是抛错:调用方可能拿一个还没到部署高度的 `latest`)
 * - 恰好整除 → 最后一格正好落在 `to`
 * - 不整除 → **最后一格必须截到 `to`**,不许越界
 *   ⚠️ 越界不是"多扫一点"那么无害:公共 RPC 对"超过 `latest`"的 `toBlock`
 *   有的直接报错,有的静默按 `latest` 处理 —— 后者会让窗口边界不可预测
 * - `to - from + 1 < size` → 单窗口
 */
export function blockWindows(
  from: bigint,
  to: bigint,
  size: bigint = LOG_WINDOW_SIZE,
): BlockWindow[] {
  // 0 或者负数会让下面的 `start += size` 原地打转,变成一个不终止的循环。
  // 这不是"防御性编程":`size` 是从外面传进来的,传错一次就是挂住不响应。
  if (size <= 0n) throw new Error(`blockWindows: size 必须为正,收到 ${size}`)
  if (from > to) return []

  const out: BlockWindow[] = []
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n
    out.push({ from: start, to: end > to ? to : end })
  }
  return out
}

/**
 * 逐窗口取,拼回**一个**数组 —— 与不切窗口时拿到的形状一致,调用方无感。
 *
 * ## ⚠️ 顺序靠的是「按下标写回」,不是 `Promise.all` 的完成顺序
 *
 * `deriveActiveState` 和看板的「最后一条事件即当前状态」都**依赖入参按发生顺序**
 * (`shared/contentActive.ts:43`)。这里能保证顺序,是因为三件事同时成立:
 * 窗口本身升序、viem 在窗口内按区块升序、而 `Promise.all` **保数组下标序**。
 *
 * 所以拼回时**必须按 `windows` 的下标取**,不能"谁先回来就先 `push` 谁"。
 * 写成后者的失败模式正是 `contentActive.ts` 记的那种:**静默给出上一次的状态,
 * 切一次看不出来、连着切两次才暴露。**
 *
 * ## 为什么全部窗口并发
 *
 * 顺序扫是**真的会更慢**,不是风格问题 —— 实测(备端点,单事件 4 窗口):
 * 顺序 **6,079 ms**,全并行 **3,215 ms**(3 事件 × 4 窗口 = 12 个请求,12/12 成功,零 429)。
 * 顺序扫 3 个事件约 18s,比修之前还慢。
 *
 * ⚠️ 但"实测 12 个并发没问题"**不等于**"无限没问题"。事件数上到两位数时
 * 这里就是 100+ 并发请求,那时要加并发上限 —— **该加的位置就是这个 `Promise.all`**,
 * 换成带上限的批处理即可,别的都不用动。今天不加,是因为演示量级到不了,
 * 而"为一个没量过的瓶颈提前上复杂度"本身也是一种错。
 */
export async function inWindows<T>(
  from: bigint,
  to: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  size: bigint = LOG_WINDOW_SIZE,
): Promise<T[]> {
  const windows = blockWindows(from, to, size)
  const chunks = await Promise.all(windows.map((w) => fetch(w.from, w.to)))
  // `flat()` 按下标顺序展开 —— 与上面那段讲的是同一件事,别改成 `sort` 或 `push`
  return chunks.flat()
}
