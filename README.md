# SplitJar · 收钱罐

> 创作者付费内容 + 链上多方分账。**人类扫码付,AI Agent 走 HTTP 402 自助付。**
>
> Avalanche Fuji (chainId 43113) · Avalanche 好玩黑客松参赛作品

创作者定好价格和分账比例,上传内容,拿到一个付费页。买家付稳定币,钱按比例**直达**各方钱包,
内容立即解锁 —— 全程无平台抽成、无资金池。

同一套付费墙同时服务两类买家:**人类**扫码付,**AI Agent** 走 HTTP 402 报价后自助付款。

---

## 当前进度

**W1 脚手架与钱包接入** —— 已完成(2026-09-21)。

- [x] Vite + React 19 + Tailwind v4 + wagmi v3 / viem 2
- [x] Fuji 链定义、USDC 地址一次配好(两端共用,见 `shared/`)
- [x] 连接钱包(Core Wallet / 注入式 + 可选 WalletConnect)、切链、余额显示
- [x] `useReadContract` 读 ERC-20 余额(wagmi v3 的 `useBalance` 已不支持 `token`)
- [x] **链上探针**:实时 gasPrice → 换算单笔分账 gas 成本(计费口径可切,默认钱包实付价)
- [x] **部署骨架**:`vercel.json` + `api/` + 前端/服务端两份 tsconfig + 环境变量分组

**W2 合约实现与部署** —— 已部署上链(2026-09-21)。

- [x] `CreatorSplitter` 按方案 §8.1 冻结接口实现(见 [contracts/](contracts/))
- [x] **27 个测试全过**,含余数归属、重入、escrow 三分支
- [x] 部署脚本 + **在真实 Fuji 上干跑验过** USDC 地址(`decimals()==6`、`symbol()=="USDC"`)
- [x] ABI 生成进 `shared/abi/`
- [x] **部署到 Fuji**,已读链验过(见下)
- [x] `evm_version` 定死 `cancun` —— Foundry 默认的 `osaka` 是 Fuji 不支持的,实测出这条
- [ ] 用真实交易的 `gasUsed` 替换 `ESTIMATED_PAY_GAS`(需要该地址有 USDC)

尚未开始:付费页(W3)、存储与门禁(W5)、Agent 路径(W7)。

> 完整工作分解见仓库外的 `开发计划.md`(WBS + 依赖 + 风险)。

### 合约地址(Fuji 43113)

```
CreatorSplitter  0xDe9b3090263e20ebD5b3795F0199B500f6da72f5
USDC             0x5425890298aed601595a70AB815c96711a31Bc65
```

部署交易 `0x2d7332bb…552d55`([在 Snowtrace 上查看](https://testnet.snowtrace.io/tx/0x2d7332bb7828671be021f513705b8be2dd285d38aa6aa3900bc8133251552d55))。
部署后逐项读链验过:字节码长度 9182(与本地产物一致)、`usdc()` immutable 接对、
`getContent` 对不存在的 id revert 出 `ContentNotFound`。

前端 `.env` 的 `VITE_SPLITTER_ADDRESS` 已按此填好;服务端要在 Vercel 环境变量里
另填一份 `SPLITTER_ADDRESS`(两端读链是两条路)。

## 快速开始

```bash
npm install
cp .env.example .env      # 可留空,注入式钱包不需要 WalletConnect
npm run dev
```

打开 http://localhost:5173,点"连接"——Core Wallet 扩展会弹出。

```bash
npm run typecheck   # tsc --noEmit
npm run build       # 类型检查 + 生产构建
```

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite + React + Tailwind v4 + wagmi / viem |
| 钱包 | Core Wallet 扩展 + WalletConnect |
| 合约 | Solidity + Foundry(`CreatorSplitter`,**W2 部署**) |
| 部署 | Vercel(前端 + Functions,免费 `*.vercel.app`) |
| 存储 | Vercel Blob **私有** + 短时效签名 URL |

## 目录结构

```
├── src/                 前端(Vercel 静态产物)
│   ├── lib/             #  前端专用:wagmi 配置、RPC 连接
│   ├── components/      #  Shell / ConnectButton / Balances / ChainProbe
│   └── App.tsx
│
├── shared/              ⭐ 前端 + 服务端共用,唯一事实来源
│   ├── chain.ts         #  链 + USDC 地址(从 viem 注册表取,不手写)
│   └── abi/             #  合约 ABI(W2 由 forge 生成,见该目录 README)
│
├── api/                 ⭐ Vercel Functions —— 一个文件 = 一个路由
│   └── health.ts        #  部署健康探针
│
├── server/              ⭐ 只在服务端跑,**不是路由**
│   └── env.ts           #  服务端环境变量登记表(= 密钥白名单)
│
├── scripts/             ⭐ 本地跑,不进构建、不进产物(如 W9 的 Agent 演示客户端)
│
└── contracts/           ⭐ Foundry 独立工具链(Vercel 完全不碰)
```

**四条边界,别混:**

- **`shared/` vs `src/lib/`** —— 两端都要的纯逻辑进 `shared/`;只有浏览器要的(React、wagmi)留 `src/lib/`。`shared/` 从 `viem` 取依赖,不从 `wagmi` 取,否则会把 React 拖进服务端。
- **`server/` 不在 `api/` 里** —— Vercel 的 `api/` 约定是每个文件变成一个**公开路由**。辅助代码放进去会被暴露出去。
- **`scripts/` 必须是第三处** —— Agent 演示客户端持有独立私钥:放 `src/` 会被打进前端产物,放 `api/` 会被部署成公开接口。只能本地 `node` 跑。
- **两份 tsconfig,故意的** —— `tsconfig.json` 带 DOM(前端),`tsconfig.api.json` 不带(服务端)。服务端代码误用 `document`/`window` 会**当场编译失败**,这是拆两份的主要理由。

## 部署(Vercel)

静态前端 + Serverless Functions 同一个项目。`vercel.json` 只做一件事:把非 `/api/*` 的路径 rewrite 到 `index.html`,让 SPA 路由(如 `/pay/:id`)不会 404。

```bash
npm i -g vercel
vercel          # 预览部署
vercel --prod   # 生产部署
```

**首次部署后必须验证两件事**(对应 `vercel.json` 那条 rewrite 规则):

1. `/api/health` 返回 JSON —— 而不是被 SPA rewrite 吃掉
2. `/` 返回页面 —— 证明 rewrite 没把静态资源一起吃掉

环境变量分两组,**中间那条线是红线**:`VITE_` 前缀会被内联进前端产物,密钥一律不加前缀。详见 `.env.example`。

## 关于 Fuji USDC

地址 `0x5425890298aed601595a70AB815c96711a31Bc65`,**6 位小数**。

代码里不手写这个地址,而是取 `viem/tokens` 的 USDC 注册表 —— 两个独立来源(Circle 官方文档、
viem 注册表)已核对一致。手写地址是经典翻车点,错了会让所有支付失败。

测试币:**Core faucet** 领 AVAX(付 gas),**Circle faucet** 领 USDC(限 1 USDC / 2 小时 / 地址)。

## 诚实边界

- 这是**测试网**作品,不涉及真实资金
- 内容存证(`keccak256` 上链)**只**证明"某文件在某个时间点已存在且未被修改",
  **不**证明版权归属,也**不是**门禁手段
- 具体定价与费率论证见产品方案文档,不在本 README 展开
