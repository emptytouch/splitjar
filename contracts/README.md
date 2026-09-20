# contracts — CreatorSplitter

付费内容 + 链上多方分账的合约。Foundry 独立工具链,**Vercel 完全不碰这个目录**。

## 复现

`lib/` 不入库(见 `.gitignore`),所以克隆后先拉依赖:

```bash
cd contracts
forge install foundry-rs/forge-std   # 只需一次
forge build
forge test
```

跑 gas 测量(不是断言测试,是打印数字):

```bash
forge test --match-path test/Gas.t.sol -vv
```

## 怎么验证目标链支持哪个 EVM 版本(不需要私钥)

`foundry.toml` 把 `evm_version` 定死在 `cancun`,依据是 2026-09-21 的实测。
换链(或升级 Foundry)后要重测,方法如下 —— **`cast call --create` 会把字节码
当 init code 在真实节点上跑一遍**,因此能直接问出某个 opcode 认不认:

```bash
export ETH_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc

# 阴性对照:0x0c 在所有版本都无效,用于确认这套探针本身靠得住
cast call --create 0x0c00                          # 应报 invalid opcode

cast call --create 0x5f00                          # PUSH0    (Shanghai)
cast call --create 0x6000600060005e00              # MCOPY    (Cancun)
cast call --create 0x600060005d00                  # TSTORE   (Cancun)
cast call --create 0x5f4900                        # BLOBHASH (Cancun)
cast call --create 0x5f1e00                        # CLZ      (Osaka)
```

2026-09-21 在 Fuji 的实测结果:

| opcode | 版本 | Fuji |
|---|---|---|
| `PUSH0` | Shanghai | ✅ 返回 `0x` |
| `MCOPY` / `TSTORE` / `BLOBHASH` | Cancun | ✅ 返回 `0x` |
| `CLZ` | Osaka | ❌ `invalid opcode: opcode 0x1e not defined` |

> ⚠️ **一个容易写错的坑**:第一版探针我把 opcode 放进 *runtime* 再由 init code
> `CODECOPY` + `RETURN` 出来 —— 那样**根本不会执行**那个 opcode,四个探针全"通过"。
> opcode 必须**直接作为 init code 本体**才会被执行。所以阴性对照不是可选项。

### 为什么这件事值得单独测

Foundry 1.7.1 的 `evm_version` 默认值是 **`osaka`**,而 Fuji 不支持 Osaka。
默认值留空的话,踩中的是**最难查的一类问题**:部署代码是数据,所以合约**能部署成功**,
却在某个调用路径上撞到无效 opcode 才 revert,报错指不到配置。

**如实说明**:就本合约的量级而言,9/21 比对过 osaka 与 cancun 两版产物,
osaka 版**没有**用到任何 Osaka 专属 opcode,所以**它本来大概率也不会炸**。
定死 `cancun` 的价值在于三点:①去掉这个潜在风险(将来加代码可能触发);
②字节码可复现;③把"Fuji 支持到哪"从猜测变成一个可重跑的验证。

同一批比对还确认了 `PUSH0` 在用 —— 这也是**不能退回 `shanghai`** 的原因:
退回去字节码会变,§12.2 的 gas 表就得重测。

## 部署到 Fuji

**用 Foundry 的加密 keystore,不要把私钥写进 `.env`。**
产品方案 §6.2:私钥仅存环境变量,绝不出现在前端产物或仓库 —— keystore 更进一步,
密钥是**加密存放、且在项目目录之外**(`~/.foundry/keystores/`)。

一次性导入:

```bash
cast wallet import splitjar-deployer --interactive
# 粘贴私钥 → 设密码(明文私钥不落盘)
```

以后部署(会提示输 keystore 密码,不回显):

```bash
forge script script/Deploy.s.sol \
  --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
  --account splitjar-deployer --broadcast
```

> ⚠️ **别把私钥放进项目里的 `.env`** —— 而且要注意:`forge` 只读 **`contracts/.env`**,
> **不读上层 `splitjar/.env`**(2026-09-21 实测:`FOUNDRY_*` 覆盖变量放上层无效)。
> 放错位置不会有任何好处,只剩"文件跟着项目跑"的风险。
>
> ⚠️ keystore 的 KDF 是 Foundry 默认的 scrypt `n=8192`,强度按现在的标准偏低 ——
> 密码别设成字典词。

想**不花钱先验一遍**,去掉 `--broadcast` 就是纯模拟(不需要私钥):

```bash
forge script script/Deploy.s.sol \
  --rpc-url https://api.avax-test.network/ext/bc/C/rpc \
  --sender 0x0000000000000000000000000000000000000001
```

这一步会在真实链上读 USDC 的 `decimals()`,因此能提前抓出"地址抄错"这类问题 ——
否则要等到第一笔支付失败才发现。

部署完把地址填到**两个地方**(前端 `.env` 的 `VITE_SPLITTER_ADDRESS`、
Vercel 服务端环境变量 `SPLITTER_ADDRESS`)。两处都要,因为前端读链和服务端读链是两条路。

## 当前部署(Fuji 43113)

| 项 | 值 |
|---|---|
| `CreatorSplitter` | `0xDe9b3090263e20ebD5b3795F0199B500f6da72f5` |
| USDC | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| 部署交易 | `0x2d7332bb7828671be021f513705b8be2dd285d38aa6aa3900bc8133251552d55` |
| 部署 gas | 1,047,491,实付 `effectiveGasPrice` **160 wei** |
| 部署者地址 | `0xA0b760DCb7561B30E728170Ce58f4df2D2843D63`(keystore 名 `splitjar-deployer`) |

> 最后那个 **160 wei** 值得留意:Foundry 走的是"本地签名 + 发原始交易"这条路,
> 所以付的是节点建议价。**浏览器钱包走的是另一条路** —— 钱包会自己加 1 nAVAX 的 tip,
> 同样的 gas 要贵 600 万倍。演示时买单的是钱包,定价必须按钱包那条算(方案 §12.2)。

## 接口来源

严格按产品方案 §8.1 的冻结清单实现(2026-09-21 冻结)。写入接口一个不多一个不少。
额外只有两个 view:`getContent` 和 `contentExists` —— 理由见 `../shared/abi/README.md`。

## 两个容易被漏掉的语义

**① 余数归最后一个收款人。** `amount * split / 10000` 是整数除法会截断。
若每方都取 floor,`0.2 USDC` 三方分账时余下的零头会**永远卡在合约里**。
所以前 N-1 方取 floor,最后一方取 `amount - 前面之和` —— 支付金额恒等于分账之和。
`test_RemainderGoesToLastRecipient` 和 `testFuzz_SumOfSharesAlwaysEqualsAmount` 钉死这一条。

**② 推送失败转待提取余额。** 每个收款方的 `transfer` 用 `try/catch` 包住,
失败则记进 `pendingBalance`,由其自行 `withdraw()`。付款人不会因为收款方的问题而交易失败。

### ⚠️ 但请如实理解 ② 防的是什么

方案 §8.2 原文的说法是"任一收款方是**拒收合约**时整笔支付 revert"。
**这个说法对 ERC-20 不成立** —— ERC-20 的 `transfer` 只是改余额,
**不调用收款方的任何代码**,收款方合约无法拒收。
`test_ERC20_NoHook_RejectingContractStillGetsPaid` 用一个"什么都 revert 的合约"
证明了它照样能收到 ERC-20。

真正的触发条件是**代币侧**失败:Circle **拉黑**收款方,或**暂停** USDC。
这两条测试用的是带 blocklist / pause 语义的替身,不是凭空造的:

| 场景 | 结果 |
|---|---|
| 收款方被拉黑 | 付款照常成功,该方份额记账;但**被拉黑期间 `withdraw()` 也会失败** |
| 拉黑解除后 | `withdraw()` 成功,钱取出来 |
| 拉款成功、推送时代币被暂停 | 付款照常成功,三方份额全记账;恢复后各自取走 |

**所以 escrow 不是万能的**:被拉黑的钱不会丢(记在账上),但在解封前动不了。
这一点值得在演示时如实讲 —— 说成"任何情况下都能拿到"就是过度承诺了。

## 安全设计

- **`creator` 和 `payer` 恒为 `msg.sender`**,不接受参数传入(v1 的两个伪造漏洞都出在这里)
- **Checks-Effects-Interactions**:`pay()` 在**任何外部调用之前**先落 `purchases` 标记。
  `test_Reentrancy_PurchaseFlagSetBeforeExternalCall` 用一个会在 `transfer` 里回调
  `pay()` 的恶意代币验证这条 —— 没有它,重入会把合约里其他买家的钱分光
- **`withdraw()` 先清零再转账**,同样防重入
- **不引入 OpenZeppelin**:整个合约只用到 `IERC20` 的两个方法,
  自带最小接口比多一个依赖少一处风险

## gas(2026-09-21 实测,`test/Gas.t.sol`)

| 收款方数 | `createContent` | `pay()` 执行 | `pay()` 含 intrinsic |
|---|---|---|---|
| 1 | 167,665 | 100,332 | 121,908 |
| 2 | 186,646 | 108,933 | 130,509 |
| **3** | **210,129** | **137,685** | **159,261** |
| 5 | 257,096 | 195,188 | 216,764 |

每个额外收款方约 +28,750 gas。

> ⚠️ 这些数**偏低**:测试替身没有代理转发、不发 `Transfer` 事件、不读黑名单存储,
> 而真实 USDC 三样都有。前端成本显示用的是覆盖修正后的保守值
> `ESTIMATED_PAY_GAS = 250_000`(见 `../shared/chain.ts`)。
> 绝对数要用一笔真实 Fuji 交易的 `gasUsed` 替换。
