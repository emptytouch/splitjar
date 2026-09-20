/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WalletConnect Cloud projectId。缺省时只启用注入式钱包(Core / MetaMask) */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
  /** 主 RPC,见开发计划 5.2 */
  readonly VITE_RPC_PRIMARY?: string
  /** 备用 RPC */
  readonly VITE_RPC_BACKUP?: string
  /** 已部署的 CreatorSplitter 地址(W2 后填) */
  readonly VITE_SPLITTER_ADDRESS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
