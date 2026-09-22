import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { DEPLOY_BLOCK } from '../../shared/chain'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { listRememberedContents } from '../lib/contentMeta'
import { deriveActiveState, isActive } from '../lib/contentActive'

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
 * 2026-09-21 实测公共 Fuji RPC 不限制 `getLogs` 范围(10 万块一次查完也成功),
 * 所以这一版不需要分页、不需要索引器。等事件多到扫不动时再上 W8 的 KV。
 *
 * ## 谁是"我的内容"
 *
 * `ContentRegistered` 里有 `indexed creator`,直接按 `args.creator` 过滤 ——
 * 这是链上的事实,不依赖本地记录。
 * **标题**是另一回事:合约不存标题,只能从本机缓存取(见 lib/contentMeta.ts)。
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
}

export type ContentRow = {
  contentId: Hex
  price: bigint
  txHash: Hex
  blockNumber: bigint
  title: string
  sales: Sale[]
  earned: bigint
  /** 链上当前是否在售 —— 由 `ContentActiveChanged` 推导,默认 `true` */
  active: boolean
}

export type MyContents = {
  rows: ContentRow[]
  times: Map<string, Date>
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

export function useMyContents() {
  const { address } = useAccount()
  const client = usePublicClient()

  const query = useQuery({
    queryKey: ['my-contents', SPLITTER_ADDRESS, address],
    enabled: Boolean(client && address),
    refetchOnMount: 'always',
    queryFn: async (): Promise<MyContents> => {
      const c = client!

      // ① 我创建的内容 —— 直接按 indexed creator 过滤,链上事实
      const registered = await c.getContractEvents({
        address: SPLITTER_ADDRESS,
        abi: creatorSplitterAbi,
        eventName: 'ContentRegistered',
        args: { creator: address },
        fromBlock: DEPLOY_BLOCK,
        toBlock: 'latest',
      })

      const mine = new Map<Hex, { price: bigint; txHash: Hex; blockNumber: bigint }>()
      for (const log of registered) {
        const id = log.args.contentId
        if (!id) continue
        mine.set(id, {
          price: log.args.price ?? 0n,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
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
      const [allSplits, allActiveChanges] = await Promise.all([
        c.getContractEvents({
          address: SPLITTER_ADDRESS,
          abi: creatorSplitterAbi,
          eventName: 'PaymentSplit',
          fromBlock: DEPLOY_BLOCK,
          toBlock: 'latest',
        }),
        c.getContractEvents({
          address: SPLITTER_ADDRESS,
          abi: creatorSplitterAbi,
          eventName: 'ContentActiveChanged',
          fromBlock: DEPLOY_BLOCK,
          toBlock: 'latest',
        }),
      ])

      // 「最后一条事件即当前状态」的推导在 `lib/contentActive.ts` 里 —— 抽出去
      // 是为了**能单独验**:那个函数最容易写错的地方是遍历顺序,而顺序反了
      // 切一次看不出来、**连着切两次才暴露**,必须能脱离链单独跑。
      // ⚠️ 它依赖入参按发生顺序(`getContractEvents` 就是这个顺序)。
      const activeOf = deriveActiveState(
        allActiveChanges
          .filter((log) => log.args.contentId)
          .map((log) => ({
            contentId: log.args.contentId!.toLowerCase(),
            active: log.args.active ?? true,
          })),
      )

      const rows: ContentRow[] = []
      const remembered = new Map(listRememberedContents().map((r) => [r.contentId, r.title]))

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
          })
        }

        sales.sort((a, b) => Number(b.blockNumber - a.blockNumber))
        rows.push({
          contentId,
          price: meta.price,
          txHash: meta.txHash,
          blockNumber: meta.blockNumber,
          title: remembered.get(contentId) ?? '',
          sales,
          earned: sales.reduce((a, s) => a + s.myShare, 0n),
          // 没改过就是注册时的初始值 `true`(合约 CreatorSplitter.sol:172)
          active: isActive(activeOf, contentId),
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

  return query
}
