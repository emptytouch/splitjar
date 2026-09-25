import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { DEPLOY_BLOCK } from '../../shared/chain'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { listRememberedContents, resolveTitle, type RowTitle } from '../lib/contentMeta'
import { useCatalog } from './useCatalog'
import { deriveActiveState, isActive } from '../../shared/contentActive'
import { ZERO_CONTENT_HASH } from '../../shared/contentHash'
import { inWindows } from '../../shared/blockWindows'
import { isAgentAddress } from '../../shared/agentAddresses'

/**
 * 「我创建的内容」—— 控制台和看板**共用**的那份查询(2026-09-23 抽出)。
 *
 * ## 为什么抽出来
 *
 * 这段逻辑原先整段住在 `DashboardPage` 里。控制台要把「你的内容」那张
 * 占位卡换成真摘要(见开发计划 §12.2),就得读同一份数据 —— 而**照抄一份
 * 查询到另一个页面**正是这个仓库一直在反对的事(同一个判断写两遍必然漂移)。
 *
 * 抽成 hook 之后两个页面共享同一个 `queryKey`,react-query 自己去重:
 * 从控制台点到 `/dashboard` 不会重扫一遍链,第一个页面读到的结果直接复用。
 *
 * ## `fromBlock` 用部署高度,不从 0 扫
 *
 * 合约只能从部署那一刻起产生事件,所以 `DEPLOY_BLOCK` 是**正确且最小**的起点。
 *
 * ### ⚠️ 2026-09-24 更正:「公共 Fuji RPC 不限制 `getLogs` 范围」**已经过期**
 *
 * 那段旧实测写的是「2026-09-21 实测公共 Fuji RPC 不限制 `getLogs` 范围
 * (10 万块一次查完也成功),所以这一版不需要分页、不需要索引器」。
 *
 * **它对备端点 `publicnode` 是假的**(上限 50,000 块),而且跨度只在涨 ——
 * 现在的跨度是 158,401 = 上限的 3.17 倍。所以这条不是"将来会过期",
 * 是**写下之后第三天就过期了**:它记的是"当时没被拒",却读成了"没有上限"。
 *
 * ⇒ 三次扫链现在统一走 `shared/blockWindows.ts` 的 `inWindows`。
 * 顺带修掉一处正确性问题:三条读的 `toBlock` 现在都钉在**同一个块号**上
 * (`latest` 各自解析会让三次读落在不同高度)。详见那个文件头 + §十一。
 *
 * KV 索引(把"每次全量"降成"只扫增量")仍是下一步,**但它必须先有窗口** ——
 * 首次仍要全量,不解决 50k 上限它一步都走不了。
 *
 * ## 谁是"我的内容"
 *
 * `ContentRegistered` 里有 `indexed creator`,直接按 `args.creator` 过滤 ——
 * 这是链上的事实,不依赖本地记录。
 * **标题**是另一回事:合约不存标题,见下。
 *
 * ## ⚠️ 2026-09-26:标题改成读服务端 KV,而且它**不能住在 `queryFn` 里**
 *
 * 原先标题只从本机 localStorage 取,于是同一件内容**广场显示「苹果图」、
 * 看板显示「未命名内容」**(在**没发布过它的那台机器**上必然如此)。
 * 现在服务端那份 KV 是主源,localStorage 退成兜底 —— 规则都在
 * `lib/contentMeta.ts` 的 `resolveTitle` 里,**这里只负责把数据喂给它**。
 *
 * ⚠️ **合并必须发生在 `queryFn` 外面**(下面那个 `useMemo`),理由是硬的:
 * 链上那份查询的 `queryKey` 只跟地址有关,它的 `queryFn` **不会**因为
 * catalog 后到而重跑。如果标题在 `queryFn` 里算,函数闭包捕获的是
 * "catalog 还没到"那一版的 `serverTitles` —— 于是**那一行会永远停在
 * 旧的标题上**,而且症状是"有时候标题是对的、有时候不是"(取决于哪个请求快)。
 *
 * 所以分工是:① `queryFn` 只产**链上事实**(`ChainRow`,没有标题);
 * ② catalog 那份到了之后,`useMemo` 把两个来源合起来。
 * 多一次网络读(react-query 自己去重,`/dashboard` 与 `/` 共享同一份),
 * 换的是"两个界面说的是同一句话"。
 *
 * ## 上下架状态也是从事件推的,不额外读链
 *
 * `ContentActiveChanged(contentId indexed, active)` 每次变更都发,
 * 且合约里**没有"值没变就不发"的空转保护**(`CreatorSplitter.sol:184-185`)。
 * 所以"最后一条事件的值"就是当前状态,不需要为每一行再打一次 `getContent`。
 *
 * 初始值是 `true` —— 合约 `CreatorSplitter.sol:172` 在注册时写死
 * `c.active = true`。**这一条是必须去合约里核实的**:猜错的话,
 * 一件从没改过上下架的内容会被推成"已下架",那是完全相反的结论。
 * 有事件时以事件为准,没事件时用这个初始值兜底。
 */

export type Sale = {
  contentId: Hex
  payer: Address
  txHash: Hex
  blockNumber: bigint
  total: bigint
  myShare: bigint
  /**
   * 这笔付款的买家**在不在 agent 白名单里**(W8)。
   *
   * ⚠️ 判据是**地址登记**,不是"识别" —— 链上没有 agent 的痕迹可识别:
   * 人类和 agent 走同一个 `pay()`、发同一个 `PaymentSplit`,而且 `msg.sender`
   * 就是买家本人(我们故意不实现 x402 代付)。所以界面上只能说
   * **「按地址白名单判定」**,不能说"自动识别"。见 `shared/agentAddresses.ts`。
   *
   * 在**查询里**算而不是在渲染时算:这样"谁是 agent"只有一个定义处,
   * 页面只负责把 `true` 画成徽章。页面若各自去 `AGENT_ADDRESSES.includes(...)`,
   * 就又是一个"写两遍必然漂移"的判断(而且漏了大小写归一化还会静默不命中)。
   */
  isAgent: boolean
}

/**
 * 查询产出的那一行 —— **还没有标题**(只有链上事实)。
 *
 * 标题那两个来源(服务端 KV / 本机)都要在**合起来**之后才算数,
 * 而合并发生在 `useMyContents` 的 `useMemo` 里(理由见文件头 2026-09-26 那段)。
 * 拆成两个类型是为了让"忘了合并"变成**编译错误** —— 直接渲染 `ChainRow.title`
 * 是取不到字段的。
 */
type ChainRow = Omit<ContentRow, 'title'>

/**
 * `queryFn` 的产出 —— **只有链上事实**。
 *
 * ⚠️ 页面**不要**用这个:它的 `rows` 没有标题。渲染请用 `useMyContents()`
 * 返回的 `rows`(合过 KV 与本机两个来源)。类型上刻意让两者不同,
 * 就是为了让"绕开合并"编译不过。
 */
export type MyContents = {
  rows: ChainRow[]
  times: Map<string, Date>
}

export type ContentRow = {
  contentId: Hex
  price: bigint
  txHash: Hex
  blockNumber: bigint
  /**
   * 标题 —— **四态,不是字符串**,理由见 `lib/contentMeta.ts` 的 `RowTitle`。
   *
   * ⚠️ 渲染时不要写 `r.title || '未命名内容'`:那会把"标不出来"和
   * "确实没有"压成同一句话,而后者是在**断言一件我们可能并不知道的事**。
   */
  title: RowTitle
  sales: Sale[]
  earned: bigint
  /** 链上当前是否在售 —— 由 `ContentActiveChanged` 推导,默认 `true` */
  active: boolean
  /**
   * 链上记的那份**内容文件的 keccak256**。
   *
   * 看板的「补预览图」用它回答一个问题:**你刚选的这个文件,是不是这一份内容?**
   * 预览图是从内容文件派生出来的,而内容字节在私有 store 里(浏览器匿名读不到,
   * 这正是我们要的效果)—— 所以补图时创作者得**在本机重新选一次原文件**。
   * 选错文件不是靠信任去防的:算一遍 keccak256 和链上这个值比,
   * 对不上就拒。传一张别的图上去比没有图更糟。
   *
   * ## 为什么是零额外 RPC
   *
   * `ContentRegistered` 事件里**自带** `contentHash`(已从 ABI 核实),
   * 所以它跟着已经扫到的那条日志一起进来,不需要为每一行再打一次 `getContent`。
   *
   * ## ⚠️ 它可能是 `0x00…00`
   *
   * W5 之前创建的内容传的是占位符 `0x0`(那时上传还没做,见
   * `lib/uploadApi.ts` 的 `computeFileHash` 注释)。那种内容**没法核对**
   * —— 判定与出路在 `isVerifiableHash`,别在这里特判。
   */
  contentHash: Hex
}

/**
 * 区块号 → 时间的缓存。同一批销售常常落在少数几个区块里,
 * 每个唯一区块只查一次。上限 24 次 —— 看板不该为了显示时间
 * 打出几十个 RPC 请求(公共端点会限流,方案 §15)。
 */
async function blockTimes(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  numbers: bigint[],
): Promise<Map<string, Date>> {
  const unique = [...new Set(numbers.map(String))].slice(0, 24)
  const out = new Map<string, Date>()
  await Promise.all(
    unique.map(async (n) => {
      try {
        const b = await client.getBlock({ blockNumber: BigInt(n) })
        out.set(n, new Date(Number(b.timestamp) * 1000))
      } catch {
        // 取不到时间就不显示时间 —— 不能让一个装饰性的字段拖垮整个看板
      }
    }),
  )
  return out
}

/**
 * 这个 hook 对外给的东西 —— **刻意比 react-query 那个结果窄**。
 *
 * `query.data.rows` 是**没有标题**的 `ChainRow`,把它透出去就等于留了一条
 * "某个页面绕开合并、自己渲染一遍"的路,而那条路的症状正是这次要修的那个 bug。
 * 所以这里只暴露合完的结果;要加字段就加在这里,顺便想清楚它归哪一层。
 */
export type MyContentsResult = {
  rows: ContentRow[]
  times: Map<string, Date>
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  refetch: () => void
}

export function useMyContents(): MyContentsResult {
  const { address } = useAccount()
  const client = usePublicClient()

  /**
   * 服务端那份标题表。⚠️ 用 `useCatalog` 而不是自己 fetch ——
   * 它是**同一个 queryKey**,`/explore` 和这一页共享一份缓存,不会多打一次。
   */
  const catalog = useCatalog()

  const query = useQuery({
    queryKey: ['my-contents', SPLITTER_ADDRESS, address],
    enabled: Boolean(client && address),
    refetchOnMount: 'always',
    queryFn: async (): Promise<MyContents> => {
      const c = client!

      // ⚠️ 先把块号定下来,再拿它当三条扫链的 `toBlock` —— 见文件头 2026-09-24 那段。
      // 这次读**不是**多余的:它同时是窗口的上界和"这份看板是哪个高度上的"的依据。
      const latest = await c.getBlockNumber()

      // ① 我创建的内容 —— 直接按 indexed creator 过滤,链上事实
      const registered = await inWindows(DEPLOY_BLOCK, latest, (from, to) =>
        c.getContractEvents({
          address: SPLITTER_ADDRESS,
          abi: creatorSplitterAbi,
          eventName: 'ContentRegistered',
          args: { creator: address },
          fromBlock: from,
          toBlock: to,
        }),
      )

      const mine = new Map<
        Hex,
        { price: bigint; txHash: Hex; blockNumber: bigint; contentHash: Hex }
      >()
      for (const log of registered) {
        const id = log.args.contentId
        if (!id) continue
        mine.set(id, {
          price: log.args.price ?? 0n,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
          // 事件自带,零额外 RPC。补成零值而不是留空:这个字段的类型是 `Hex`,
          // 而"核对了不了"在链上的表达就是零值 —— 能不能核对由
          // `isVerifiableHash` 判,不在这一层造第三态(见 shared/contentHash.ts)
          contentHash: log.args.contentHash ?? ZERO_CONTENT_HASH,
        })
      }

      // ② 所有分账事件,再按"是不是我创建的 contentId"筛。
      //
      // 为什么不给 getLogs 传 contentId 过滤:那要对每个 contentId 单独查一次。
      // 这些内容总共也没几件,一次全查完再在内存里筛更省请求。
      // (等到事件量真的上来,这一条就该换成 W8 的 KV 索引)
      //
      // 上下架变更同理:一次全查,内存里按 contentId 收敛到"最后一条"。
      // 每次切换都会发一条(合约没有空转保护),所以最后一条即当前值。
      // ⚠️ 两条走同一个 `latest`,所以它们看的是**同一个高度** ——
      // 列表与上下架状态不会自己跟自己不一致。
      const [allSplits, allActiveChanges] = await Promise.all([
        inWindows(DEPLOY_BLOCK, latest, (from, to) =>
          c.getContractEvents({
            address: SPLITTER_ADDRESS,
            abi: creatorSplitterAbi,
            eventName: 'PaymentSplit',
            fromBlock: from,
            toBlock: to,
          }),
        ),
        inWindows(DEPLOY_BLOCK, latest, (from, to) =>
          c.getContractEvents({
            address: SPLITTER_ADDRESS,
            abi: creatorSplitterAbi,
            eventName: 'ContentActiveChanged',
            fromBlock: from,
            toBlock: to,
          }),
        ),
      ])

      // 「最后一条事件即当前状态」的推导在 `shared/contentActive.ts` 里 —— 抽出去
      // 是为了**能单独验**:那个函数最容易写错的地方是遍历顺序,而顺序反了
      // 切一次看不出来、**连着切两次才暴露**,必须能脱离链单独跑。
      // ⚠️ 它 2026-09-23(W7)从 `src/lib/` 挪到了 `shared/`,因为服务端也要判下架 ——
      // 照抄一份就是两份会漂移的判断。
      // ⚠️ 它依赖入参按发生顺序(`getContractEvents` 就是这个顺序)。
      const activeOf = deriveActiveState(
        allActiveChanges
          .filter((log) => log.args.contentId)
          .map((log) => ({
            contentId: log.args.contentId!.toLowerCase(),
            active: log.args.active ?? true,
          })),
      )

      const rows: ChainRow[] = []

      for (const [contentId, meta] of mine) {
        const sales: Sale[] = []

        for (const log of allSplits) {
          if (log.args.contentId !== contentId) continue

          // 分账事件里**自带** recipients/amounts,所以不必再读一次 getContent。
          //
          // ⭐ **同一个地址可以在 `recipients` 里出现多次,必须把每一笔都加上。**
          // 2026-09-23 用户报的 bug:他把「协作者」填成了自己的地址,于是链上是
          //   recipients = [创作者, 创作者]   amounts = [0.0495, 0.0005]
          // 而这里原先写的是 `recipients.findIndex(...)` —— **只取第一个匹配**,
          // 于是「累计收入」显示 0.0495,少算了协作者那一份。
          //
          // ⚠️ 链上完全正确:合约按 99%/1% 给同一个地址**打了两笔 transfer**,
          // 合计 0.05。这笔账错在显示层 —— 而「分账透明」正是这个产品的卖点,
          // 少算一笔比不显示更糟。
          //
          // `forEach` + 累加,而不是 `findIndex`:合约不禁止同一地址出现多次
          // (它只校验"非空、无零地址、每项 > 0、合计 = 10000")。
          const recipients = log.args.recipients ?? []
          const amounts = log.args.amounts ?? []
          const me = address!.toLowerCase()
          let myShare = 0n
          let matched = false
          recipients.forEach((r, i) => {
            if (r.toLowerCase() === me) {
              matched = true
              myShare += amounts[i] ?? 0n
            }
          })
          if (!matched) continue // 这笔跟我无关

          sales.push({
            contentId,
            payer: log.args.payer!,
            txHash: log.transactionHash!,
            blockNumber: log.blockNumber!,
            total: amounts.reduce((a, b) => a + b, 0n),
            myShare,
            // 传进去的 `payer` 是 viem 解出来的 checksum 形态,白名单里可能写的是
            // 全小写 —— 归一化在 `isAgentAddress` 里做,这里**别自己写 `includes`**。
            isAgent: isAgentAddress(log.args.payer),
          })
        }

        sales.sort((a, b) => Number(b.blockNumber - a.blockNumber))
        rows.push({
          contentId,
          price: meta.price,
          txHash: meta.txHash,
          blockNumber: meta.blockNumber,
          sales,
          earned: sales.reduce((a, s) => a + s.myShare, 0n),
          // 没改过就是注册时的初始值 `true`(合约 CreatorSplitter.sol:172)
          active: isActive(activeOf, contentId),
          contentHash: meta.contentHash,
        })
      }

      rows.sort((a, b) => Number(b.blockNumber - a.blockNumber))
      const times = await blockTimes(
        c,
        rows.flatMap((r) => r.sales.map((s) => s.blockNumber)),
      )
      return { rows, times }
    },
  })

  /**
   * 服务端那份标题表。`null` = **拿不到**(还没到 / 读失败)—— 与
   * "服务端说这件内容没有标题"是两回事,判据见 `resolveTitle`。
   *
   * 键统一**小写**:contentId 在链上、在 KV、在这份表里的形态不保证一致,
   * 少一次归一化就是"明明有、却查不到"。
   */
  const serverTitles = useMemo(() => {
    if (!catalog.data) return null
    return new Map(catalog.data.items.map((i) => [i.contentId.toLowerCase(), i.title]))
  }, [catalog.data])

  /**
   * 本机那份。⚠️ 读 localStorage 放在 `useMemo` 里而不是 `queryFn` 里:
   * 一来 `queryFn` 已经不该碰标题了,二来这样它和 catalog 是同一个时机,
   * 两边的取舍一样(不跟着链上那次扫描反复重读)。
   */
  const localTitles = useMemo(
    () => new Map(listRememberedContents().map((r) => [r.contentId.toLowerCase(), r.title])),
    [],
  )

  const rows = useMemo<ContentRow[]>(
    () =>
      (query.data?.rows ?? []).map((r) => ({
        ...r,
        title: resolveTitle({
          contentId: r.contentId,
          serverTitles,
          // ⚠️ catalog **没有 data 且还在加载**才是 pending。`isError` 时
          // `isPending` 也是假 —— 那一路要落到 `unknown` 上,不能混
          serverPending: catalog.isPending,
          localTitles,
        }),
      })),
    [query.data, serverTitles, catalog.isPending, localTitles],
  )

  return {
    rows,
    times: query.data?.times ?? EMPTY_TIMES,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
  }
}

/**
 * 空表常量。
 *
 * ⚠️ 每次渲染现造一个 `new Map()` 会让下游的 `useMemo`/依赖比较每次都判"变了" ——
 * 数据还没到时这个值会被读很多次,没必要每次都造一个新的。
 */
const EMPTY_TIMES: Map<string, Date> = new Map()
