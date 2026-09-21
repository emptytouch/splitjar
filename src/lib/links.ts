import type { Address, Hex } from 'viem'
import { CHAIN, USDC } from '../../shared/chain'

/**
 * 外部链接的集中处。
 *
 * 单独一个文件的理由:这些 URL 会在付费页、看板、创建页三处出现,
 * 散着写就一定会有一处写错 —— 而"链上地址点开是 404"是最伤可信度的一类小错。
 * 演示时评委真的会点。
 */

/**
 * 区块浏览器。
 *
 * ⚠️ Avalanche 的浏览器 2025 年从 Snowtrace 换成了 Routescan 系,
 * 但 **`testnet.snowtrace.io` 仍然可用且是大家认得的域名**,所以用它。
 * 若哪天失效,改这一处即可。
 */
const EXPLORER = 'https://testnet.snowtrace.io'

export function explorerTx(hash: Hex): string {
  return `${EXPLORER}/tx/${hash}`
}

export function explorerAddress(address: Address): string {
  return `${EXPLORER}/address/${address}`
}

export function explorerToken(address: Address): string {
  return `${EXPLORER}/token/${address}`
}

/** 当前部署的合约在浏览器上的页面 */
export const EXPLORER_BASE = EXPLORER

/** Circle 官方 USDC 水龙头。每地址每 2 小时 1 USDC,一笔支付花 0.2 */
export const USDC_FAUCET = 'https://faucet.circle.com'

/** AVAX 水龙头(Core 官方)。买家没 AVAX 付不了 gas —— 开发计划 R3 */
export const AVAX_FAUCET = 'https://core.app/tools/testnet-faucet'

/** 给"余额不足"这类文案用的、带单位的当前网络说明 */
export const NETWORK_LABEL = `${CHAIN.name}(${CHAIN.id})`

/** USDC 在浏览器上的页面 */
export const USDC_EXPLORER = explorerToken(USDC.address)

/** 交易哈希的短显示 —— 移动端宽度金贵,完整 66 字符会折成三行 */
export function shortHash(hash: Hex, lead = 8, tail = 6): string {
  return `${hash.slice(0, 2 + lead)}…${hash.slice(-tail)}`
}

export function shortAddress(address: Address, lead = 6, tail = 4): string {
  return `${address.slice(0, 2 + lead)}…${address.slice(-tail)}`
}
