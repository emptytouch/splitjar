import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { DEPLOY_BLOCK } from '../../shared/chain'
import { SPLITTER_ADDRESS, creatorSplitterAbi } from '../lib/splitter'
import { listRememberedContents, resolveTitle, type RowTitle } from '../lib/contentMeta'
import { useCatalog } from './useCatalog'
import { inWindows } from '../../shared/blockWindows'

/**
 * 「我买过的内容」—— 买家视角的购买记录(方案 3)。
 *
 * 与 `useMyContents`(按 creator 过滤 ContentRegistered)对称:这里按 **payer**
 * 过滤 `PaymentSplit` 事件。同一份 ABI / 窗口分页逻辑,没有新的业务判断。
 *
 * 标题四态合并照搬 `useMyContents` 的分工:`queryFn` 只产链上事实,
 * 标题在 `useMemo` 里合(catalog KV + 本机 localStorage 兜底),合并不进 `queryFn`
 * 否则会停在旧标题上。详见 `useMyContents` 文件头 2026-09-26 那段。
 *
 * 买家看到的每一行都是**已购**,所以直接给下载入口 —— 走到 `/p/:id`,
 * 付费页闸门识别 already-owned 直接放行。
 */

export type Purchase = {
  contentId: Hex
  total: bigint
  txHash: Hex
  blockNumber: bigint
  title: RowTitle
}

type ChainPurchase = Omit<Purchase, 'title'>

export type MyPurchases = {
  rows: ChainPurchase[]
  times: Map<string, Date>
}

export type MyPurchasesResult = {
  rows: Purchase[]
  times: Map<string, Date>
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  refetch: () => void
}

export function useMyPurchases(): MyPurchasesResult {
  const { address } = useAccount()
  const client = usePublicClient()
  const catalog = useCatalog()

  const query = useQuery({
    queryKey: ['my-purchases', SPLITTER_ADDRESS, address],
    enabled: Boolean(client && address),
    refetchOnMount: 'always',
    queryFn: async (): Promise<MyPurchases> => {
      const c = client!
      const latest = await c.getBlockNumber()

      const allSplits = await inWindows(DEPLOY_BLOCK, latest, (from, to) =>
        c.getContractEvents({
          address: SPLITTER_ADDRESS,
          abi: creatorSplitterAbi,
          eventName: 'PaymentSplit',
          fromBlock: from,
          toBlock: to,
        }),
      )

      // 按付款地址过滤 —— 这是链上事实,不依赖本地记录。
      const me = address!.toLowerCase()
      const map = new Map<Hex, { total: bigint; txHash: Hex; blockNumber: bigint }>()
      for (const log of allSplits) {
        const payer = log.args.payer
        if (!payer || payer.toLowerCase() !== me) continue
        const id = log.args.contentId
        if (!id) continue
        const amounts = log.args.amounts ?? []
        const total = amounts.reduce((a, b) => a + b, 0n)
        // 同一 contentId 多次购买(理论被合约拦,这里取最新一笔)→ 覆盖为最后一条
        map.set(id, { total, txHash: log.transactionHash!, blockNumber: log.blockNumber! })
      }

      const rows: ChainPurchase[] = [...map.entries()].map(([contentId, m]) => ({
        contentId,
        total: m.total,
        txHash: m.txHash,
        blockNumber: m.blockNumber,
      }))

      rows.sort((a, b) => Number(b.blockNumber - a.blockNumber))
      const times = await blockTimes(c, rows.map((r) => r.blockNumber))
      return { rows, times }
    },
  })

  const serverTitles = useMemo(() => {
    if (!catalog.data) return null
    return new Map(catalog.data.items.map((i) => [i.contentId.toLowerCase(), i.title]))
  }, [catalog.data])

  const localTitles = useMemo(
    () => new Map(listRememberedContents().map((r) => [r.contentId.toLowerCase(), r.title])),
    [],
  )

  const rows = useMemo<Purchase[]>(
    () =>
      (query.data?.rows ?? []).map((r) => ({
        ...r,
        title: resolveTitle({
          contentId: r.contentId,
          serverTitles,
          // catalog 还没到 → pending;isError 落到 unknown,不能混
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

/** 区块号 → 时间的缓存(装饰性字段,取不到就不显示,不拖垮页面) */
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
        // 取不到时间就不显示时间
      }
    }),
  )
  return out
}

const EMPTY_TIMES: Map<string, Date> = new Map()
