import { fallback, http } from 'wagmi'
import { CHAIN, DEFAULT_RPC_BACKUP, DEFAULT_RPC_PRIMARY } from '../../shared/chain'

/**
 * RPC 主备(方案 §15 / 开发计划 5.2)。
 *
 * ⚠️ **这里只管"网页自己读链"**(余额、事件、门禁查询)。
 * **发交易走的是钱包内置的 RPC**,与本文件无关 —— 所以别把钱包的连通性
 * 记到这里头上。
 *
 * ⚠️ 服务端门禁读链是**另一条链路**(`server/chain.ts`),两条的默认端点
 * 取自 `shared/chain.ts`,不在这里另写一份 —— 默认值不一致会造成
 * "网页说买了、服务端说没买"这种最难排查的分歧。
 */
const PRIMARY = import.meta.env.VITE_RPC_PRIMARY ?? DEFAULT_RPC_PRIMARY
const BACKUP = import.meta.env.VITE_RPC_BACKUP ?? DEFAULT_RPC_BACKUP

/** `rank: false` —— 固定主备顺序,不做延迟竞速。演示要的是"可预测",不是"最快" */
export const rpcTransport = fallback([http(PRIMARY), http(BACKUP)], {
  rank: false,
  retryCount: 1,
})

export const CHAIN_ID = CHAIN.id
