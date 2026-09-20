import { createConfig } from 'wagmi'
import { walletConnect } from 'wagmi/connectors'
import { CHAIN } from '../../shared/chain'
import { rpcTransport } from './rpc'

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID

/**
 * 注入式钱包(Core Wallet / MetaMask / OKX…)由 wagmi 自动发现,**不需要显式声明**。
 *
 * WalletConnect 需要 projectId,没配就跳过 —— 这样 `.env` 空着也能跑起来,
 * 不阻塞 W1 的完成定义(那一步只要求 Core 扩展能连上)。
 * projectId 在 https://cloud.walletconnect.com 免费申请。
 */
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: projectId ? [walletConnect({ projectId })] : [],
  transports: { [CHAIN.id]: rpcTransport },
  ssr: false,
})

/** 是否已配 WalletConnect —— UI 用它决定要不要提示"手机钱包扫码不可用" */
export const hasWalletConnect = Boolean(projectId)
