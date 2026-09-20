import { fallback, http } from 'wagmi'
import { CHAIN } from '../../shared/chain'

/**
 * RPC 主备(方案 §15 / 开发计划 5.2)。
 *
 * ⚠️ **这里只管"网页自己读链"**(余额、事件、门禁查询)。
 * **发交易走的是钱包内置的 RPC**,与本文件无关 —— 所以别把钱包的连通性
 * 记到这里头上。
 *
 * 候选端点的可用性要在 9/22 实测后固化进环境变量。默认值是 Ava Labs 官方
 * 测试网 RPC(最可靠的那个)+ PublicNode 兜底。
 */
const PRIMARY = import.meta.env.VITE_RPC_PRIMARY ?? 'https://api.avax-test.network/ext/bc/C/rpc'
const BACKUP = import.meta.env.VITE_RPC_BACKUP ?? 'https://avalanche-fuji-c-chain-rpc.publicnode.com'

/** `rank: false` —— 固定主备顺序,不做延迟竞速。演示要的是"可预测",不是"最快" */
export const rpcTransport = fallback([http(PRIMARY), http(BACKUP)], {
  rank: false,
  retryCount: 1,
})

export const CHAIN_ID = CHAIN.id
