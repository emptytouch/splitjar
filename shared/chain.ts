import type { Address } from 'viem'
import { avalancheFuji } from 'viem/chains'
import { usdc } from 'viem/tokens'

/**
 * 链与币的常量 —— **前端和服务端共用**。
 *
 * 为什么在 `shared/` 而不是 `src/lib/`:服务端读链校验(¥ 402 的 5 项检查)也要
 * USDC 地址和 chainId。放在 `shared/` 是让"两端必须是同一个值"变成结构上的事实,
 * 而不是靠两边各写一份、靠人记得同步。
 *
 * ⚠️ 这里从 `viem/chains` 取,不从 `wagmi/chains` 取 ——
 * `wagmi` 会拖进 React,服务端不该引它。`viem` 两边都干净。
 *
 * ⚠️ 两个 tsconfig 都会检查这个文件(见 tsconfig.api.json),**故意如此**:
 * 它在浏览器和 Node 两个环境下都必须成立。
 */

/** Fuji C-Chain(chainId 43113)—— 本次参赛唯一目标网络 */
export const CHAIN = avalancheFuji

/**
 * Fuji USDC —— **地址从 viem 的 USDC 注册表取,不手写。**
 *
 * 两个独立来源已核对一致(2026-09-21):
 *   ① Circle 官方 faucet 文档
 *   ② viem `usdc.addresses[43113]`
 *
 * 手写地址是经典翻车点,而且错了会让**所有**支付失败。让库供址,顺便每次升级都重新校验一遍。
 *
 * `decimals: 6` —— 合约里 `price` 的单位就是它(方案 §8.1:0.1 USDC → 100000)。
 */
export const USDC = {
  address: usdc.addresses[CHAIN.id] as Address,
  decimals: usdc.decimals,
  symbol: usdc.symbol,
}

/**
 * 已部署的 `CreatorSplitter`(Fuji,2026-09-21 部署)。
 *
 * ⚠️ **这里必须是纯常量,不能写 `import.meta.env`** —— 本文件两端共用,
 * 而服务端(Node)里根本没有 `import.meta`。想让"克隆下来就能跑"成立,
 * 就得把默认值放在这,由两端**各自**读自己的环境变量来覆盖:
 *
 *   前端  `import.meta.env.VITE_SPLITTER_ADDRESS ?? DEPLOYED_SPLITTER`
 *   服务端 `serverEnv('SPLITTER_ADDRESS') ?? DEPLOYED_SPLITTER`
 *
 * 前端 `src/lib/rpc.ts` 的 `?? 'https://…'` 就是这个先例。
 */
export const DEPLOYED_SPLITTER = '0xDe9b3090263e20ebD5b3795F0199B500f6da72f5' as Address

/**
 * 上面那个合约**部署所在的高度** —— 看板 `eth_getLogs` 的 `fromBlock` 起点。
 *
 * 不从 0 开始扫:部署之前的区块不可能有我们的事件,白扫等于白等。
 * 合约只能从部署那一刻起产生事件,所以这是**正确且最小**的起点。
 *
 * 2026-09-21 实测公共 Fuji RPC **不限制 `getLogs` 范围**(10 万块一次查完也成功),
 * 所以这一版不需要分页、不需要索引器(方案 §10 的"方案 A")。
 * 顺带:这个常数也是 W5/W8 服务端事件索引的起点,不要另写一份。
 */
export const DEPLOY_BLOCK = 58_513_443n

/**
 * 3 方 `pay()` 的 gas 估算,**用于把 gasPrice 换算成"每笔成本"**。
 *
 * ## 付款路径长什么样(先纠正一处我此前写错的说法)
 *
 * 合约**没有**用 ERC-3009 `receiveWithAuthorization`,也没有 ECDSA 验签。
 * §8.1 的 `pay(bytes32)` 不收签名参数,§11 明确「人类与 Agent 共用同一个 `pay()`,
 * v2.1 全部改动都在 HTTP 层」。付款走的就是最普通的
 * `approve` + `transferFrom`,分账时每方一次 `transfer`。
 * EIP-712 是用在 §9.2 的**内容门禁**上的,不在付款路径上。
 *
 * ## 取值(2026-09-21)
 *
 * `contracts/test/Gas.t.sol` 实测出**形状**:每个额外收款方约 +28,750 gas,
 * 3 方 `pay()` 执行 137,685、含 intrinsic 159,261。
 *
 * ⚠️ 但那个绝对数**偏低,不能直接用**:测试替身没有代理转发、不发 `Transfer`
 * 事件、不读黑名单存储,而真实 USDC 这三样都有(实测一笔真实 USDC 转账
 * 76,277 gas,含 intrinsic)。估计差 ~26,500 gas/方。
 *
 * 所以这里仍取 **250,000** —— 它同时是实测抽样到的 3 方调用上界,
 * 也覆盖上述修正后的估计值(~239,000)。**宁可高估**:这个常数是定价门槛的分母,
 * 取小了门槛就是假的。
 *
 * 📌 W2 的收尾项:部署到 Fuji 后用一笔**真实交易**的 `gasUsed` 替换本值,
 * 并同步填进方案 §12.2 的表格 —— 黑客松里编数据比没有数据更糟。
 */
export const ESTIMATED_PAY_GAS = 250_000n

/**
 * 钱包默认附加的 1 gwei 小费。
 *
 * 这是整个定价判断的关键,且**与节点报的价差 600 万倍**:
 * 2026-09-21 实测 Fuji,`eth_gasPrice` / `eth_maxPriorityFeePerGas` 只报
 * 160 / 150 wei,但**钱包发出的交易** `effectiveGasPrice` 一律是
 * 1,000,000,010 wei(= 1 nAVAX)。用脚本自己拼交易的会付 160 wei,
 * 用钱包点确认的会付 1 nAVAX。
 *
 * 演示是**买家在钱包里点确认**,所以必须按这个数算。
 * (顺带印证了方案 §12.2.1 的「1 nAVAX」量级是对的 —— 但它描述成"基础费",
 *  机制说错了:真基础费只有 10 wei,那 1 nAVAX 是钱包自己加的 tip。)
 */
export const WALLET_DEFAULT_TIP = 1_000_000_000n
