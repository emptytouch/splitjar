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

**W3 人类路径最小闭环** —— 已完成(2026-09-22)。

- [x] **付费页 `/p/:contentId`**:扫码打开 → 连钱包 → `approve` + `pay` 两笔 → 即时解锁
- [x] **付款状态机**(`src/lib/payMachine.ts` + `payErrors.ts`)—— 纯逻辑单独成模块:
      每一种失败都映射到一个**明确的界面状态**,不落进"都显示处理中然后卡死"
- [x] **RPC 超时不得显示成功**(方案 §14.2)—— 成功态只有一条路径能到达,没有旁路
- [x] **收款看板 `/dashboard`**:`getLogs` 按 `creator` 过滤直接渲染,**不依赖索引器**
- [x] 分享二维码、标题本地缓存(合约不存标题)、ABI 从 `.json` 改成 `.ts`

**W4 分账完整化** —— 已完成(2026-09-22)。

- [x] **N 方分账编辑器**(最多 10 方,实时校验合计 = 100%,余数归属与合约逐字一致)
- [x] **收款方领取界面** —— `pendingBalance` → `withdraw()`,收款方自己连钱包取走
- [x] **被代币合约拦住时如实讲**(方案 §8.2):被 Circle 拉黑的地址在解封前**取不出来**,
      界面直说"钱没丢、解封后能取",并且**不给重试按钮**(重试解决不了拉黑)
- [x] 在 fork 上用**真实 Fuji USDC** 完整验证 escrow 全链路(含拉黑 / 解锁 / 拒签)

**W5 存储与人类门禁** —— 代码已落地(2026-09-23),⚠️ **三条验收尚未实测**。

- [x] **两个 Blob store**:内容走**私有** store,预览图走**公开** store ——
      `access` 是 **store 级、平台强制**,一个 store 装不下
- [x] **客户端直传**(`handleUpload` 签受限 token),不走 Function 中转 ——
      Function 请求体上限 4.5 MB,而内容文件没有尺寸约束
- [x] **`/api/unlock`** 六道检查:成形 → 验签 → deadline → nonce(绑定 `contentId`)
      → **链上 `purchases`** → 原子消耗 nonce,签发 60s 短时效 URL
- [x] **`server/env.ts`** 是服务端变量的唯一事实来源 —— 把方案 §6.2「私钥不进前端
      产物」从"靠人记得"变成**编译期可拦**
- [ ] ⚠️ **未付款 → 401 / 已付款 → 真的下载到文件(`sha256` 相等)/ URL 过期后失效**
      —— **不是"验了没通过",是本机发不出请求**(Blob 数据面与 `*.vercel.app`
      都是定向屏蔽)。**部署后必须补,这是 W5 的完成定义。**

**W7 Agent 路径服务端** —— 代码已落地(2026-09-23),⚠️ **一半验收只能部署后跑**。

- [x] **`GET /api/catalog`** —— 发现入口。扫 `ContentRegistered` 事件建列表,
      **零次 `eth_call`**(`price` / `creator` 注册后不可变,已从 ABI 核实),
      在架的才列
- [x] **`GET /api/content/:id`** —— 没凭证 → **402 + 一份 HMAC 签名的报价**;
      带 `X-Payment` → 五条校验 → 一分钟后自动失效的下载链接
- [x] **`POST /api/content-meta`** —— 创作者写标题进 KV(catalog 的 `title` 来自这里)
- [x] 报价**签名载荷只有 `contentId + quoteId + expiresAt`** —— 判据是"验签那一刻
      服务端能不能重新算出来"(详见 `docs/W7-实施计划.md` §1.3)
- [x] 防重放用 **KV 短租约**(占位 60s → 成功才落定),让"原子"与"记在成功之后"
      两条要求同时成立
- [x] **`npm run typecheck` + `npm run build` 都过**;本机实测过的反例见
      `docs/W7-实施计划.md` §6.1/§6.2
- [ ] ⚠️ **反例 2/3/4/5/7/9 与 happy path 尚未实测** —— 它们全要过 `reservePayment`,
      而 **`*.upstash.io` 在本机被定向屏蔽**。**部署后必须补。**
- [ ] ⚠️ **`403 content_inactive` 未实测** —— 需要一件已下架的内容,本机只有一件
      且在架

> ### ⚠️ 关于 x402:我们**复用它的形态,没有实现它**
>
> 报价体、字段命名、`method` 都照着 x402 来,让认这个标准的评委一眼看得懂。
> 但**结算不是 x402**,而且**信任模型正好相反**:
>
> | | 真 x402 | 我们 |
> |---|---|---|
> | 支付头装的 | **未广播的签名授权**(EIP-3009),由 facilitator 代付广播 | **已广播交易的哈希**,我们只去链上查证 |
> | 谁广播 | facilitator(gasless) | 买家自己(两笔:`approve` + `pay`) |
> | `payTo` | 单个 payee | **`CreatorSplitter` 合约** —— 一笔付款当场分给 N 方 |
>
> 最后一行的差别不是实现细节:x402 的 `exact` scheme 只有单 payee,
> **容纳不下"同一笔付款分给 N 个收款人"**,而这正是本产品的核心。
>
> 所以准确的说法是「**复用 x402 的交互形态与报价字段命名**」。
> **我们不声明"实现了 x402"** —— 完整推演见 `docs/W7-实施计划.md` §〇。

**W8 Agent 演示客户端** —— 代码已落地(2026-09-24)。

- [x] **`scripts/agent-buy.mjs`** —— 一个自己发现、自己付款、自己取内容的 agent。
      **八步全程打印,每个关键值都标来源**(方案 §五 的反造假红线:金额只认 402 的
      `accepts[0]`,买哪件由脚本自己从 catalog 挑,付款人由私钥推导再回链核对)
- [x] 前四步(自检 → 发现 → 402 → 报价)**一分钱不花**,`--dry-run` 停在付款那一刻之前
- [x] **看板给 agent 的付款打 `[Agent]` 徽章** —— 判据是
      `shared/agentAddresses.json` 的**地址白名单**,与脚本读**同一个文件**
- [x] `npm run typecheck` + `npm run build` 都过;本机实测(含**负对照**)见
      `docs/W8-实施计划.md` §六
- [ ] ⚠️ **第 5–8 步(真花钱那一段)未实测** —— 需要 agent 的私钥,而按方案 §6.2
      它只在**你自己那个 shell** 里。命令见下面那一节。

> ⚠️ **`[Agent]` 徽章是"按地址白名单判定",不是"自动识别"。**
> agent 与人类走的是**同一个** `pay(bytes32)`、留下**同一个** `PaymentSplit`,
> `msg.sender` 就是买家 —— 链上没有留下任何可分辨的痕迹。剩下的办法只有启发式
> (gas 价、时间簇、地址聚类),全是猜。**如实说边界,好过含糊地说"能识别"。**
> 完整推演与备选方案见 `docs/W8-实施计划.md` §〇。

尚未开始:体验模式(W6,已推迟)、初筛材料(W10)、打磨(W11)、端到端联调(W9)。

> 完整工作分解见 `docs/开发计划.md`(WBS + 依赖 + 风险)。
> 产品方案见 `docs/splitjar-product-spec.md`;各工作包的实施记录见 `docs/W3-实施计划.md`
> / `docs/W4-实施计划.md` / `docs/W5-实施计划.md`;两份调研附录也在 `docs/`。

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

### 跑一遍 Agent 自主购买(W8)

一个命令,agent 自己走完全程:

```bash
export AGENT_PRIVATE_KEY=0x…        # ⚠️ 只在当前 shell,用完关窗口。绝不写进 .env
export AGENT_ADDRESS=0x…            # 可选,给了就与私钥推导的地址交叉核对
node scripts/agent-buy.mjs --dry-run   # 先演习:停在付款那一刻之前,一分钱不花
node scripts/agent-buy.mjs             # 真跑:approve + pay + 取内容 + 比哈希
```

⚠️ 脚本默认打 `http://127.0.0.1:3000`(本机 API),要**先**把服务端跑起来(见下)。
`--content 0x…` 可以指定买哪一件;不带就由脚本自己从 `/api/catalog` 挑。

前四步(自检 → 发现 → 402 → 报价)不花任何钱,所以 `--dry-run` 之外的参数也可以
反复跑到第 4 步,只是到那里就会真的发交易。

要让这笔付款在看板上带 `[Agent]` 徽章,把 agent 的地址写进
`shared/agentAddresses.json`(脚本自检时会把你该粘的那一行直接打出来)。

#### 演示顺序(§16.1 第 7 条要看的那一屏)

三个角色**各一个地址**,缺一不可 —— 人类那一笔和 agent 那一笔必须落在
**同一个创作者、同一页看板**上,否则"分账比例一致"这句话就没有对照组。

```
① 创作者 0xAa05f680…  在 /create 建一件并定价(建议 0.1 USDC)
                       → 拿到付费页链接
② 人类买家 0x737a8a9E… 打开那个链接,连着钱包点付款(approve + pay)
③ agent   0x0016486a… node scripts/agent-buy.mjs
                       → 它自己发现、自己付、自己取内容
④ 创作者打开 /dashboard:同一件内容下面并排两笔
                       —— 一笔来自 0x737a8a9E…(人类)
                       —— 一笔来自 0x0016486a… 且带 [Agent] 徽章
                       两笔的分账明细格式与比例完全一样
```

②③ 的顺序**不能换**:反过来也能出徽章,但那时看板上只有 agent 一笔,
没法当场对比 —— 而对比正是这一条要验的东西。

### 手动走一遍 Agent 那条路(W7 的完成定义)

不用脚本,`curl` 也能走完同一条路 —— 每一步在干什么看得更清楚。

⚠️ **要用 `vercel dev`,不是 `npm run dev`** —— 后者只是 Vite(5173),
它**不提供 `/api/*`**,打过去一律 404。`vercel dev` 才会把 `api/` 下的文件
挂成路由(默认 3000)。

⚠️ 还有一个**本机开发拓扑**的坑(2026-09-24 实测):`vercel.json` 里那条
`rewrites: /((?!api/).*) → /index.html` 在 `vercel dev` 里**也生效** ——
它把 `/src/main.tsx` 都改写成 index.html,所以 **:3000 上跑不起来前端**。
本机开发要**两个**:
- `npx vercel dev --listen 3000` —— 只提供 `/api/*`
- `npx vite --port 5173` —— 前端页面(而且只能用 `localhost:5173`,
  vite 只绑了 IPv6 的 `[::1]`,`127.0.0.1:5173` 连不上)

```bash
npx vercel dev --listen 3000 --yes

# 0. 发现 —— 在架的内容和价格
curl -s localhost:3000/api/catalog

# 1. 报价 —— 没带 X-Payment,拿到 402 + 一份签了名的报价
curl -si localhost:3000/api/content/0x<contentId> | head -20

# 2. 付款 —— Agent 自己发两笔:approve(USDC → 合约),然后
#    CreatorSplitter.pay(bytes32 contentId)   ← 与人类路径同一个函数

# 3. 取内容 —— 回显第 1 步那份报价,带上已广播交易的哈希
curl -s -H 'X-Payment: {"txHash":"0x…","payer":"0x…",
  "quoteId":"0x…","expiresAt":…,"sig":"0x…"}' \
  localhost:3000/api/content/0x<contentId>
# → {"url":"https://…","expiresInSeconds":60}
```

⚠️ 本机要跑通第 1 步,`QUOTE_HMAC_SECRET` **必须已配置**(见"部署"那节的说明)。
第 3 步还要 KV —— 本机 `*.upstash.io` 不通,只能部署后验。

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
│   ├── lib/             #  wagmi 配置、RPC、以及**纯逻辑**:
│   │                    #    payMachine/payErrors(付款状态机)、claimMachine(领取)、units
│   ├── hooks/           #  usePayFlow —— 状态机与 wagmi 的接线
│   ├── components/      #  Shell / ConnectButton / Balances / ChainProbe
│   │                    #  PayStatus(付款状态机→界面)/ ClaimPending(领取)/ ShareQr
│   ├── pages/           #  ConsolePage / CreatePage / PayPage / DashboardPage
│   └── App.tsx
│
├── shared/              ⭐ 前端 + 服务端共用,唯一事实来源
│   ├── chain.ts         #  链 + USDC 地址(从 viem 注册表取,不手写)
│   ├── eip712.ts        #  两份 EIP-712 签名的 domain + 解析原语
│   ├── upload.ts        #  `Upload` 授权(内容/预览图两用,决定落哪个 store)
│   ├── unlock.ts        #  `Unlock` 授权(人类取内容那条路)
│   ├── agentPay.ts      #  402 报价 / `X-Payment` / catalog 的线上格式(W7)
│   ├── agentAddresses.ts#  ⭐ W8 · "谁是 agent"的唯一判据(读下面那份 JSON)
│   ├── agentAddresses.json # ⭐ W8 · Agent 地址白名单。**公开文件,只放地址**
│   ├── contentActive.ts #  「最后一条上下架事件即当前状态」的纯推导(W7 从 src/ 挪上来)
│   ├── contentMeta.ts   #  标题的长度上限与截断规则(两端同一套)
│   ├── storage.ts       #  Blob 路径规则(内容私有 / 预览图公开)
│   ├── api.ts           #  错误信封 `{ error: { code, message } }` + 状态码
│   └── abi/             #  合约 ABI(W2 由 forge 生成,见该目录 README)
│
├── api/                 ⭐ Vercel Functions —— 一个文件 = 一个路由
│   ├── health.ts        #  部署健康探针(含"哪几个服务端变量配了")
│   ├── unlock.ts        #  人类取内容(六道检查 → 60s 短时效 URL)
│   ├── unlock-nonce.ts  #  签发解锁用的 nonce
│   ├── upload.ts        #  签发受限上传 token(内容直传的那张门票)
│   ├── catalog.ts       #  ⭐ W7 · Agent 的发现入口
│   ├── content-meta.ts  #  ⭐ W7 · 创作者写标题进 KV
│   └── content/[id].ts  #  ⭐ W7 · 402 报价 / 带凭证据取内容(`[id]` = 动态路由)
│
├── server/              ⭐ 只在服务端跑,**不是路由**
│   ├── env.ts           #  服务端环境变量登记表(= 密钥白名单)
│   ├── chain.ts         #  服务端读链(门禁的信任面)+ W7 的事件扫描
│   ├── kv.ts            #  Upstash Redis:nonce / 402 防重放 / 内容标题
│   └── quote.ts         #  402 报价的 HMAC 签与验
│
├── scripts/             ⭐ 本地跑,**不进构建、不进产物**(见下"四条边界"第三条)
│   ├── agent-buy.mjs    #  ⭐ W8 · Agent 演示主角:发现 → 402 → 报价 → 付款 → 取内容
│   └── verify-x402.mjs  #  W7 · 反例矩阵(逐条打服务端,不用钱包)
│                        #  ⚠️ 这两个是 `.mjs` 而不是 `.ts`:**两个 tsconfig 的
│                        #     include 都不含 scripts/**,写 .ts 就 import 不到 shared/
│
└── contracts/           ⭐ Foundry 独立工具链(Vercel 完全不碰)
```

**为什么状态机在 `lib/` 而不是组件里:** 「什么情况下可以重试」「哪种失败必须显示成功」
这类判断写错的代价是**用户重复付款**。它们被放进不依赖 React 的纯模块,
组件只负责画 —— 见 [`src/lib/payMachine.ts`](src/lib/payMachine.ts) 与
[`src/lib/claimMachine.ts`](src/lib/claimMachine.ts) 的头部注释。

**四条边界,别混:**

- **`shared/` vs `src/lib/`** —— 两端都要的纯逻辑进 `shared/`;只有浏览器要的(React、wagmi)留 `src/lib/`。`shared/` 从 `viem` 取依赖,不从 `wagmi` 取,否则会把 React 拖进服务端。
- **`server/` 不在 `api/` 里** —— Vercel 的 `api/` 约定是每个文件变成一个**公开路由**。辅助代码放进去会被暴露出去。
- **`scripts/` 必须是第三处** —— Agent 演示客户端持有独立私钥:放 `src/` 会被打进前端产物,放 `api/` 会被部署成公开接口。只能本地 `node` 跑。**这个目录 W9 才会建**,规则先立在这里,别到那时才想起来。
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

**部署后必须补验一条(W7)**:`/api/health` 的 `serverEnv.items` 里
**`QUOTE_HMAC_SECRET` 要显示 `configured: true`**。没配的话 402 那条路会直接回
503 —— 这是刻意的:一份**没签名**的报价流出去,"报价有效期"那道校验就形同虚设。
用 `openssl rand -hex 32` 生成,⚠️ **永远不要加 `VITE_` 前缀**。

⚠️ **本机 `vercel dev` 有个坑**:`.env.local` 里明明有 `BLOB_READ_WRITE_TOKEN`,
但 dev 会**把这一条丢掉**(它是 Vercel 的保留名),`/api/health` 会显示
`configured: false`。要本地测那条路,起 dev server 时显式 export 一个值即可
(假的也行)。**线上不是这个原因** —— 线上是 Vercel 自己注入的真值。

## 关于 Fuji USDC

地址 `0x5425890298aed601595a70AB815c96711a31Bc65`,**6 位小数**。

代码里不手写这个地址,而是取 `viem/tokens` 的 USDC 注册表 —— 两个独立来源(Circle 官方文档、
viem 注册表)已核对一致。手写地址是经典翻车点,错了会让所有支付失败。

测试币:**Core faucet** 领 AVAX(付 gas),**Circle faucet** 领 USDC(限 1 USDC / 2 小时 / 地址)。

## 诚实边界

- 这是**测试网**作品,不涉及真实资金
- 内容存证(`keccak256` 上链)**只**证明"某文件在某个时间点已存在且未被修改",
  **不**证明版权归属,也**不是**门禁手段
- **escrow 不是"任何情况下钱都拿得到"。** 某一方的转账失败时,那份会记账到
  `pendingBalance`,由他本人 `withdraw()` 取走 —— 但**如果那笔转账失败是因为
  代币侧拦住了(收款地址被 Circle 拉黑、或 USDC 被暂停),那么解封之前
  `withdraw()` 同样取不出来**。钱不会被别人拿走,也不会丢,就是动不了。
  界面如实说明这一点,不给"重试"按钮(重试解决不了拉黑)。
  ⚠️ 触发条件是**代币侧失败**,不是"收款方拒收" —— ERC-20 的 `transfer`
  只改余额、不调用收款方任何代码,所以收款方是合约也拒收不了。
- escrow 还缺一环:**通知没有收件人**。合约不知道收款方的联系方式,
  所以"有一笔钱被暂存了"这件事,只有他自己连上钱包看看板才知道
- **Agent 路径对齐的是 x402 的形态,不是 x402 本身** —— 见上面 W7 那一段的对照表。
  最本质的一条:我们的支付头装的是**已广播交易的哈希**,
  而 x402 装的是**待广播的签名授权**。信任模型相反。
- **Agent 路径没有 reorg 保护。** 五条校验的第 ①②③ 条塌缩成"收据成功 +
  `PaymentSplit` 日志在场",判据是**确定性**的而不是"N 个确认"。
  Fuji 演示可以接受,**上主网这里必须改成等确认数**。
- **服务端读链走的是我们配的 RPC,不是"经过验证的付费墙"** ——
  RPC 说谎,门禁就判错。真要更硬得自己跑节点或验轻客户端证明,不在当前范围。
- **catalog 的 `title` 可能为 `null`**:链上不存标题,唯一来源是 KV,
  而在 `POST /api/content-meta` 之前创建的内容没有这份记录。
  走**重试**或**跳过上传**路径创建的内容也会缺(拿不到那条授权签名,见 W7 实施计划 §二)
- 具体定价与费率论证见产品方案文档,不在本 README 展开
