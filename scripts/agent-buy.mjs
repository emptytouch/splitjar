#!/usr/bin/env node
/**
 * W8 演示主角:一个**自己发现、自己付款、自己取内容**的 agent。
 *
 * 开发计划 §W8 第 400 行明说:「脚本要**打印每一步**,因为它是演示主角,过程要能被看见。」
 * 所以下面每一步都有对应的输出,而且**关键的值都标了来源** —— 见 §五 的反造假红线。
 *
 * ## ⚠️ 这个脚本里**不许出现**的三个值(方案 §五,W8 的验收红线)
 *
 * | 值 | 必须来自 | 为什么 |
 * |---|---|---|
 * | 要付多少钱 | `402` 响应的 `accepts[0].maxAmountRequired` | 不是常量,也**不是 `catalog` 的 `price`** —— 后者是同一个值,所以"从 catalog 读"看起来对、测起来也对,但它绕过了"被拦下 → 读报价 → 按报价付款"这个动作本身 |
 * | 要买哪一件 | `/api/catalog` 的返回,**由脚本自己挑** | `--content` 可以覆盖,但**默认必须是它自己挑的** |
 * | 付款人是本人 | 本地私钥推导出的地址,**再回链上核对** | 不是写死的字符串 |
 *
 * 这是**唯一一条"做对了也看不出来、做假了也看不出来"**的要求 ——
 * 所以它写在这里,而不是靠自觉。
 *
 * ## ⚠️ 私钥纪律(`.env.example` 与方案 §6.2)
 *
 * 私钥**只从当前 shell 的环境变量读**,绝不落盘、绝不进仓库、绝不进前端产物。
 * 这个脚本也不会把它打印出来 —— 打印的只有**推导出来的地址**。
 *
 * ## 八步
 *
 * | # | 做什么 | 花钱吗 |
 * |---|---|---|
 * | 0 | 自检:推导地址、交叉核对、读余额 | 否 |
 * | 1 | 发现:自己去 `/api/catalog` 挑一件 | 否 |
 * | 2 | 被拦:确认拿到 `402` + `accepts[0]` | 否 |
 * | 3 | 报价:从 `accepts[0]` 读金额,核对 contentId 绑定 | 否 |
 * | 4 | 授权:读 allowance,**够就跳过** | 是 |
 * | 5 | 付款:裸交易调 `pay(contentId)` | 是 |
 * | 6 | 交付:带 `X-Payment` 重试**同一条路径** | 否 |
 * | 7 | 下载 + 比哈希 | 否 |
 * | 8 | 收尾:链上可验的三条 + 机器可读的收尾行 | 否 |
 *
 * 前四步一分钱不花,`--dry-run` 停在第五步的交易**之前**(见第 4 步)。
 *
 * ## 用法
 *
 * ```bash
 * export AGENT_PRIVATE_KEY=0x…        # ⚠️ 只在当前 shell,用完关窗口
 * export AGENT_ADDRESS=0x…            # 可选,给了就交叉核对(见第 0 步)
 * node scripts/agent-buy.mjs                    # 全套,真花钱
 * node scripts/agent-buy.mjs --dry-run          # 停在付款那一刻之前
 * node scripts/agent-buy.mjs --content 0xe2f8…  # 指定买哪一件
 * ```
 *
 * 环境变量:
 *   AGENT_PRIVATE_KEY  **必需**。agent 的私钥,`0x` + 64 hex
 *   AGENT_ADDRESS      可选。公开地址。给了就与私钥推导值**交叉核对**,不一致直接拒跑
 *   BASE_URL           默认 `http://127.0.0.1:3000`(与 `scripts/verify-x402.mjs` 同)
 *   AGENT_RPC          默认走公共 Fuji(与 `shared/chain.ts` 的 `DEFAULT_RPC_PRIMARY` 同值)
 *                      这个端点抽风时换一个:`AGENT_RPC=https://avalanche-fuji-c-chain-rpc.publicnode.com`
 */

import { readFileSync } from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
} from 'viem'
import { avalancheFuji } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

/* ───────────────────────────── 常量 ───────────────────────────── */

/**
 * ⚠️ 这些值都是**从源码抄过来的**,每条注了出处 —— 抄写有漂移风险,
 * 所以让来源可见(同 `scripts/verify-x402.mjs` 的规矩)。
 *
 * ⚠️ **USDC 地址不在这里**:它从合约的 `usdc()` 读(见第 0 步)。
 * 抄一个地址进来就等于多一处会过期的常量,而链上那个永远是当前值。
 */
const SPLITTER = '0xDe9b3090263e20ebD5b3795F0199B500f6da72f5' // shared/chain.ts DEPLOYED_SPLITTER
const DEFAULT_RPC = 'https://api.avax-test.network/ext/bc/C/rpc' // shared/chain.ts DEFAULT_RPC_PRIMARY
const PAYMENT_HEADER = 'X-Payment' // shared/agentPay.ts PAYMENT_HEADER
const CAIP2_NETWORK = 'eip155:43113' // shared/agentPay.ts CAIP2_NETWORK

/**
 * ⚠️ **打本机 dev server 要用 `127.0.0.1`,不能用 `localhost`** ——
 * 这台机器上 `localhost` 走 IPv6,`fetch` 直接连不上(端口在 `0.0.0.0:3000` 上听着)。
 * 与 `verify-x402.mjs` 同一个坑,同一个默认值。
 */
const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const RPC = process.env.AGENT_RPC ?? DEFAULT_RPC

const DRY_RUN = process.argv.includes('--dry-run')
const VERBOSE = process.argv.includes('--verbose')
const CONTENT_ARG = argValue('--content')

/**
 * 演示用的**另外两个角色**的地址 —— 用来挡「agent 与人类买家混用同一个地址」。
 *
 * 为什么必须挡(风险 W8-6):三个角色共用一个地址会互相挤 faucet 额度,
 * 更要命的是**看板会把人类那一笔也标成 Agent** —— 那一屏就废了。
 *
 * 出处(2026-09-24 用户指定演示角色,两句都已在链上核过 checksum):
 *   0xAa05…0bba  本次演示的**创作者**
 *   0x737a…ebae  本次演示的**人类买家**
 *   0xA0b7…3D63  创作者 / 部署者(keystore `splitjar-deployer`)——
 *                在架内容 `0xe2f8…` 是它建的,**仍然在用**,所以一并挡
 *   0x9750…B988  上一轮的买家(链上两笔 `PaymentSplit` 的 payer)——
 *                它手上还握着演示要用的 USDC,可能还会付款,所以一并挡
 *
 * ⚠️ 新老两套都列进来是**故意保守**:这个名单只用来"拒绝跑",
 * 误挡一个其实没在用的地址,代价是改一行;漏挡一个的代价是**看板标错人**。
 */
const KNOWN_OTHER_ROLES = {
  '0xAa05f6809B1f358e53f2c1D65A75eD6b7aAd0bba': '本次演示的创作者',
  '0x737a8a9E051a3a43a26c45Fb5511f768acB0ebae': '本次演示的人类买家',
  '0xA0b760DCb7561B30E728170Ce58f4df2D2843D63': '创作者 / 部署者(keystore splitjar-deployer)',
  '0x9750Af96716784390A76420312D57fdadEB4B988': '上一轮的买家(链上实测的 payer)',
}

/** 白名单文件 —— 与前端 `shared/agentAddresses.ts` 读的是**同一份** */
const WHITELIST_PATH = new URL('../shared/agentAddresses.json', import.meta.url)

/** `CreatorSplitter` 上我们要用的两个 view。`parseAbiItem` 现写,因为 `shared/abi/` 是 TS */
const PURCHASES_ABI = parseAbiItem(
  'function purchases(bytes32 contentId, address payer) view returns (bool)',
)
const USDC_OF_SPLITTER = parseAbiItem('function usdc() view returns (address)')
const PAY_ABI = parseAbiItem('function pay(bytes32 contentId)')
/**
 * `getContent` 的输出顺序照抄 `src/lib/splitter.ts:53` 的解构:
 * `[creator, price, contentHash, recipients, splits, active]`。
 * ⚠️ 多返回值在 viem 里解成**位置元组**,没有具名属性 —— 顺序抄错不会报错,只会读错值。
 */
const GET_CONTENT_ABI = parseAbiItem(
  'function getContent(bytes32 contentId) view returns (address creator, uint256 price, bytes32 contentHash, address[] recipients, uint16[] splits, bool active)',
)

const EXPLORER = 'https://testnet.snowtrace.io' // src/lib/links.ts:19
const txLink = (h) => `${EXPLORER}/tx/${h}`

/**
 * 等收据的超时。**比前端那个 90 秒长,是故意的。**
 *
 * 前端那个数(`src/lib/payErrors.ts` 的 `RECEIPT_TIMEOUT_MS`)是为了"别让按钮死 6 分钟",
 * 而 CLI 每一步都打印、进度是可见的,长等待不会变成"卡住的按钮"。
 * 反过来,超时太短会让一次正常的 RPC 抖动把已经发出去的交易报成失败 —— 那更坏。
 */
const RECEIPT_TIMEOUT_MS = 120_000

/**
 * ⚠️ 注意这里**没有** `--verify-hash` 之类的开关:第 7 步下到内容就一定比哈希。
 * 它只多一次 `getContent` 读(免费),却能把"拿到的就是当初上传那份"从
 * "应该吧"变成链上可查的一句话 —— 这种便宜不该留成可选项。
 */

/* ───────────────────────────── 输出 ───────────────────────────── */

const tty = process.stdout.isTTY
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s)
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s)
const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s)

/** 步骤标题 —— 演示时要让人看得见"进行到哪一步了" */
function step(n, title) {
  console.log(`\n${bold(`【第 ${n} 步】${title}`)}`)
}

/**
 * 标签列宽(终端**列**,不是字符数)。
 *
 * ⚠️ 必须按显示宽度算,不能 `padEnd` —— 一个中文字占**两列**但只算**一个字符**,
 * 用 `padEnd` 会让「它要多少钱」这类标签后面的值和它**粘在一起**
 * (实测踩到:`x402Version1`、`expiresAt1790191100`)。ASCII 标签则相反,会多留空格。
 */
const LABEL_COLUMNS = 12
function displayWidth(s) {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    // CJK 与全角区段 —— 够用了,这里没有生僻字
    n +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1
  }
  return n
}
/** 一条"字段 + 值 + 来源" —— 来源是反造假红线的一部分,所以它有固定位置 */
function field(label, value, source) {
  const gap = ' '.repeat(Math.max(1, LABEL_COLUMNS - displayWidth(label)))
  console.log(`  ${label}${gap}${value}`)
  if (source) console.log(`  ${' '.repeat(LABEL_COLUMNS)}${dim(`└ 来源:${source}`)}`)
}
/** 致命错误 —— 说清楚**为什么停**,而不是只抛一个异常栈 */
function die(msg, hint) {
  console.error(`\n${yellow('✗ 停止:')}${msg}`)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

/* ───────────────────────────── HTTP ───────────────────────────── */

/**
 * 打一次接口。**"连不上"与"HTTP 报错"必须分开** ——
 * 否则一次网络抖动会伪装成"服务端拒了我",那是最容易误判的一类。
 */
async function call(path, { header } = {}) {
  const url = `${BASE_URL}${path}`
  if (VERBOSE) console.log(dim(`  → ${header ? `${PAYMENT_HEADER} … ` : ''}${url}`))
  let res
  try {
    res = await fetch(url, { headers: header ? { [PAYMENT_HEADER]: header } : {} })
  } catch (e) {
    die(
      `连不上 ${url} —— ${e.message}`,
      `  · 打本机:先确认 dev server 在跑,且用 127.0.0.1 而不是 localhost\n` +
        `    (本机 dev server 与 API 都在 :3000 —— \`npx vercel dev --listen 3000\`)`,
    )
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 300)
  }
  return { status: res.status, body }
}

/* ───────────────────────────── 第 0 步 ───────────────────────────── */

/** 读白名单。规则与 `shared/agentAddresses.ts` **逐条相同**,理由见那边的注释 */
function readWhitelist() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(WHITELIST_PATH, 'utf8'))
  } catch (e) {
    die(`读不了白名单 ${WHITELIST_PATH.pathname} —— ${e.message}`)
  }
  // ⚠️ 非 strict 的 `getAddress` 会拿输入自己算 checksum 再和输入比,
  // **全小写地址**会被它判成"校验和不符"而抛。所以先 toLowerCase。
  // 这与前端 `shared/agentAddresses.ts` 的处理必须一致 ——
  // ⚠️ 一致性无法靠编译器保证:`scripts/` 在两个 tsconfig 的 include 之外,
  // 所以这里**不能** import 那个 `.ts`。改那边时记得同步这里(两边都只有一行)。
  return (parsed.agents ?? []).map((e) => getAddress(String(e?.address ?? '').toLowerCase()))
}

async function step0(ctx) {
  step(0, '自检 —— 我是谁、我有没有钱、看板认不认我')

  // ── 私钥 → 地址 ──────────────────────────────────────────────
  const pk = process.env.AGENT_PRIVATE_KEY
  if (!pk) {
    die(
      '没有 AGENT_PRIVATE_KEY。',
      `  ⚠️ 私钥只在当前 shell export,绝不写进 .env / 仓库 / 前端产物(方案 §6.2):\n` +
        `      export AGENT_PRIVATE_KEY=0x…\n` +
        `      node scripts/agent-buy.mjs`,
    )
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    die(`AGENT_PRIVATE_KEY 形状不对 —— 期望 0x + 64 位 hex,实得 ${pk.length} 个字符。`)
  }

  const account = privateKeyToAccount(pk)
  const agent = getAddress(account.address)
  field('我是谁', agent, '本地私钥推导(privateKeyToAccount)')

  // 钱包客户端在这里建,**因为私钥只在这一层出现过** ——
  // 往下传的是 `account`,不是那串 hex(第 4/5 步要用它签名)。
  ctx.account = account
  ctx.wallet = createWalletClient({ account, chain: avalancheFuji, transport: http(RPC) })

  // ── 与 AGENT_ADDRESS 交叉核对 ────────────────────────────────
  // 两个都给了就必须一致 —— 不一致说明"你以为在用的地址"和"真的在付款的地址"
  // 不是同一个,而这正是"看板标错人"的成因之一
  const declared = process.env.AGENT_ADDRESS
  if (declared) {
    const want = getAddress(declared.toLowerCase())
    if (want !== agent) {
      die(
        `AGENT_ADDRESS(${want})与私钥推导出的地址(${agent})不是同一个。`,
        `  这两个都会被用到:私钥决定"谁在付款",AGENT_ADDRESS 决定"你以为是谁"。\n` +
          `  不一致时脚本会按私钥走,而看板按别的东西标 —— 先让它们对上再跑。`,
      )
    }
    console.log(`  ${dim('AGENT_ADDRESS 与私钥一致 ✓')}`)
  } else {
    console.log(`  ${dim('(没给 AGENT_ADDRESS —— 跳过交叉核对)')}`)
  }

  // ── 别和另外两个角色撞车(风险 W8-6)────────────────────────
  const clash = KNOWN_OTHER_ROLES[agent]
  if (clash) {
    die(
      `这个地址是别的角色在用:${clash}。`,
      `  agent 必须用自己的专属地址(开发计划 §十「Agent 脚本 / 人类买家 / 创作者各一个」)。\n` +
        `  撞车会让 faucet 额度互相挤,而且看板会把那个角色买的东西也标成 Agent —— 那一屏就废了。`,
    )
  }

  // ── 看板认不认我 ────────────────────────────────────────────
  const whitelist = readWhitelist()
  ctx.whitelisted = whitelist.some((a) => a === agent)
  if (ctx.whitelisted) {
    field('看板认吗', green('认 —— 在 shared/agentAddresses.json 里'), '该文件的 agents[].address')
  } else {
    console.log(`  ${yellow('看板不认 —— 这个地址不在白名单里')}`)
    console.log(
      dim(
        `           后果:链上一切照常,但看板会把这笔标成「人类」 ——\n` +
          `           这是白名单路线的固有边界(W8 方案 §〇),不是 bug。\n` +
          `           要标上,把下面这条加进 shared/agentAddresses.json 的 agents 数组:`,
      ),
    )
    console.log(
      `\n      { "address": "${agent}", "label": "agent 演示脚本 (scripts/agent-buy.mjs)" }\n`,
    )
  }

  // ── 钱够不够 ────────────────────────────────────────────────
  ctx.usdc = await ctx.client.readContract({
    address: SPLITTER,
    abi: [USDC_OF_SPLITTER],
    functionName: 'usdc',
  })
  field('USDC 合约', ctx.usdc, '链上读 splitter.usdc() —— 不抄常量')

  const [avax, usdcBal] = await Promise.all([
    ctx.client.getBalance({ address: agent }),
    ctx.client.readContract({
      address: ctx.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [agent],
    }),
  ])
  ctx.avax = avax
  ctx.usdcBalance = usdcBal

  field('AVAX', `${formatUnits(avax, 18)} AVAX`, '链上 getBalance —— 两笔交易的 gas')
  field('USDC', `${formatUnits(usdcBal, 6)} USDC`, '链上 balanceOf —— 要付的钱从这里出')

  // ⚠️ 余额不足**不终止** —— 第 0–3 步一分钱都不花,拿到报价本身是有价值的输出
  // (演示时"余额是 0 也能走到报价"比"脚本当场退出"更说明问题)。所以只警告。
  if (avax === 0n) {
    console.log(
      `\n  ${yellow('⚠️ AVAX 是 0 —— 第 4 步之后的交易发不出去。')}` +
        dim('先去 faucet 领一点。'),
    )
  }
  if (usdcBal === 0n) {
    console.log(
      `\n  ${yellow('⚠️ USDC 是 0 —— 就算有 gas 也付不了。')}` +
        dim('Circle faucet 限每地址 1 USDC / 2 小时,可以多备地址错开。'),
    )
  }

  return agent
}

/* ───────────────────────────── 第 1 步 ───────────────────────────── */

async function step1(ctx) {
  step(1, '发现 —— 自己去 /api/catalog 看看有什么可买')

  const got = await call('/api/catalog')
  if (got.status !== 200) {
    die(
      `/api/catalog 返回 ${got.status} ${JSON.stringify(got.body).slice(0, 200)}`,
      `  这条是 W7 交付的接口。本机起服务端要靠 \`npx vercel dev --listen 3000\`。`,
    )
  }

  const items = got.body.items ?? []
  console.log(`  ${dim(`catalog 返回 ${items.length} 件在架内容(区块高度 ${got.body.blockNumber})`)}`)

  if (items.length === 0) {
    die(
      'catalog 是空的 —— 没有在架内容可买。',
      `  先去 /create 建一件,或者用 /dashboard 把某件重新上架。`,
    )
  }

  // ── 挑哪一件:脚本自己决定 ──────────────────────────────────
  //
  // 规则**必须能说出来**,否则"自主决策"就成了"随机选一个"。
  // 这里的规则是:在**没买过**的里面挑**最便宜**的。
  //   ① 没买过 —— 合约 `CreatorSplitter.sol:215` 对同一地址买同一件会 revert
  //      `AlreadyPurchased`,挑一件已经买过的等于故意去撞墙(风险 W8-7)
  //   ② 最便宜 —— 省 faucet 额度(Circle 限每地址 1 USDC / 2h)
  //
  // ⚠️ 这一步是**读链**(`purchases`),不发交易、不花钱。
  const boughtFlags = await Promise.all(
    items.map((it) =>
      ctx.client.readContract({
        address: SPLITTER,
        abi: [PURCHASES_ABI],
        functionName: 'purchases',
        args: [it.contentId, ctx.agent],
      }),
    ),
  )
  const candidates = items.map((it, i) => ({ ...it, bought: boughtFlags[i] }))

  for (const c of candidates) {
    console.log(
      `    ${c.bought ? dim('买过  ') : green('没买过')} ` +
        dim(
          `${c.contentId}  ${formatUnits(BigInt(c.price), c.decimals)} ${c.currency}` +
            `  ${c.title ?? '(无标题)'}`,
        ),
    )
  }

  let pool = candidates.filter((c) => !c.bought)
  if (pool.length === 0) {
    console.log(
      `\n  ${yellow('这家店我能买的都买过了。')}` +
        dim('合约不允许同一地址对同一件内容付第二次。'),
    )
    die(
      '没有可买的内容。',
      `  ① 换一件:--content <另一个 contentId>\n` +
        `  ② 或去 /create 建一件新的,再跑一次\n` +
        `  ⚠️ --dry-run 不覆盖这种情况:它停在付款前,所以"能不能付"它测不出来。`,
    )
  }

  if (CONTENT_ARG) {
    const want = CONTENT_ARG.toLowerCase()
    const forced = pool.find((c) => c.contentId.toLowerCase() === want)
    if (!forced) {
      die(
        `--content ${CONTENT_ARG} 不在"我没买过的在架内容"里。`,
        `  可选:${pool.map((c) => c.contentId).join('\n        ')}`,
      )
    }
    ctx.chosen = forced
    ctx.chosenWhy = '命令行 --content 指定的'
  } else {
    // 价格是十进制字符串,**转 BigInt 再比** —— 别用 Number 比钱
    pool = pool.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1))
    ctx.chosen = pool[0]
    ctx.chosenWhy = 'catalog 里没买过的最便宜的一件(省 faucet 额度)'
  }

  const c = ctx.chosen
  console.log()
  field('买这件', c.contentId, '来自 /api/catalog 的返回')
  field('为什么', ctx.chosenWhy, '脚本自己的挑选规则')
  field('链上价', `${formatUnits(BigInt(c.price), c.decimals)} ${c.currency}`, 'catalog 的 price 字段(⚠️ 不是付款依据,见第 3 步)')
}

/* ───────────────────────────── 第 2 步 ───────────────────────────── */

async function step2(ctx) {
  step(2, '被拦下 —— 不带凭证去要内容,应得 402')

  const path = `/api/content/${ctx.chosen.contentId}`
  const got = await call(path)
  ctx.path = path

  if (got.status !== 402) {
    die(
      `期望 402,实得 ${got.status} ${JSON.stringify(got.body).slice(0, 200)}`,
      `  402 是"请先付款"这个正常流程的一步,不是失败。\n` +
        `  拿到别的东西说明前面就不对了(下架?contentId 不对?服务端没配好?)。`,
    )
  }
  if (got.body.error !== 'payment_required') {
    die(`402 的 body 形状不对:error === ${JSON.stringify(got.body.error)}`)
  }

  console.log(`  ${green('402 payment_required')} ${dim(`← ${path} 不带 ${PAYMENT_HEADER}`)}`)
  const a = got.body.accepts?.[0]
  if (!a) die('402 里没有 accepts[0] —— 报价呢?')
  ctx.accepts0 = a
  ctx.paymentRequiredBody = got.body

  field('x402Version', String(got.body.x402Version))
  field('它要多少钱', String(a.maxAmountRequired), '402 的 accepts[0].maxAmountRequired')
  field('付给谁', a.payTo, 'accepts[0].payTo(= CreatorSplitter 合约,不是收款人)')
  field('什么币', a.asset, 'accepts[0].asset(USDC)')
  field('怎么转', a.extra?.assetTransferMethod, 'accepts[0].extra —— 如实写了我们没有实现 EIP-3009 代付')
  field('网络', a.network, `应为 ${CAIP2_NETWORK}`)
}

/* ───────────────────────────── 第 3 步 ───────────────────────────── */

async function step3(ctx) {
  step(3, '解析报价 —— 从 402 里取出要付多少、以及那份签名报价')

  const a = ctx.accepts0
  const q = ctx.paymentRequiredBody.quote
  if (!q) die('402 里没有 quote 字段 —— 服务端没签报价?')

  // ⚠️ **金额只认这一条来源。** `catalog` 里也有 price,值也一样 ——
  // 正因为一样,"从 catalog 读"才是一个**看起来对、测起来也对**的错误写法:
  // 它绕过了"被拦下 → 读报价 → 按报价付款"这个动作,而那正是这一屏要演示的。
  const amount = BigInt(a.maxAmountRequired)
  ctx.amount = amount
  ctx.quote = q

  field('要付', `${formatUnits(amount, 6)} USDC (= ${amount})`, green('402 的 accepts[0].maxAmountRequired'))
  field('quoteId', q.quoteId, '402 的 quote —— 付款后要回显它')
  field('expiresAt', `${q.expiresAt} ${dim(`(${new Date(q.expiresAt * 1000).toLocaleString('zh-CN')})`)}`, '402 的 quote —— 15 分钟有效期')
  field('sig', `${String(q.sig).slice(0, 18)}…`, '402 的 quote —— 服务端 HMAC,回显时改一位就验不过')

  // 报价绑在内容上,换个路径就验不过(W7 §5.4 第 4 条)。
  // 所以第 6 步必须**用完全相同的 path** 去赎。
  if (String(ctx.paymentRequiredBody.contentId).toLowerCase() !== ctx.chosen.contentId.toLowerCase()) {
    die(
      `402 里的 contentId(${ctx.paymentRequiredBody.contentId})与我们要买的那件(${ctx.chosen.contentId})不一致。`,
    )
  }
  console.log(`  ${dim('contentId 与要买的那件一致 ✓(报价绑定内容,第 6 步必须用同一条路径赎)')}`)

  // ── 对账:402 说的 == catalog 说的(只核对,不用来决定付多少)──
  const catalogPrice = BigInt(ctx.chosen.price)
  if (catalogPrice !== amount) {
    console.log(
      `\n  ${yellow(`⚠️ 对账不一致:catalog 说 ${catalogPrice},402 说 ${amount}。`)}` +
        dim('\n     付款按 402 的走。这个不一致说明链上价格在两次读之间变了,或者有个地方在撒谎。'),
    )
  } else {
    console.log(`  ${dim(`对账:catalog 的 price 也是 ${amount} ✓(但付款依据是 402,不是它)`)}`)
  }

  // ── 钱够不够付这一笔 ────────────────────────────────────────
  if (ctx.usdcBalance < amount) {
    die(
      `USDC 不够:有 ${formatUnits(ctx.usdcBalance, 6)},要付 ${formatUnits(amount, 6)}。`,
      `  Circle faucet 限每地址 1 USDC / 2 小时(不是总量限制,多备地址是线性扩容)。\n` +
        `  也可以先 --content 挑一件更便宜的。`,
    )
  }
  console.log(
    `  ${dim(`余额够付 ✓(有 ${formatUnits(ctx.usdcBalance, 6)} USDC,要付 ${formatUnits(amount, 6)})`)}`,
  )
}

/* ───────────────────────────── 第 4 步 ───────────────────────────── */

/**
 * 授权额度 —— **够就跳过**,和人类路径同一条规则(`src/lib/payGate.ts:146`:
 * `needsApprove = (allowance ?? 0n) < price`)。
 *
 * ⚠️ 对 agent 而言"少一笔交易"还多一层意义:**少一次演示现场失败的机会**。
 * 但**不能把"跳过"写死在报告里** —— 跳过与不跳过的输出必须能区分,
 * 否则"这一场到底跑了一笔还是两笔"就说不清了。
 *
 * ⚠️ `--dry-run` 时**照常读、照常报,只是不签**。理由:读是免费的,
 * 而"额度够不够"恰恰是 dry-run 最该告诉人的事之一。
 */
async function step4(ctx) {
  step(4, '授权额度 —— 够就跳过,不够才签第一笔')

  const allowance = await ctx.client.readContract({
    address: ctx.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.agent, SPLITTER],
  })
  ctx.didApprove = allowance < ctx.amount

  field('现有额度', `${formatUnits(allowance, 6)} USDC`, '链上读 USDC.allowance(我, CreatorSplitter)')
  field('要付', `${formatUnits(ctx.amount, 6)} USDC`, '第 3 步从 402 拿到的那个数')

  console.log(
    ctx.didApprove
      ? `  ${green('额度不够 —— 要签 approve,这一场发 2 笔交易')}`
      : `  ${green('额度够 —— 跳过 approve,这一场只发 1 笔交易')}`,
  )

  // ⚠️ 停在这一句**之前**,而不是"额度不够时才停"。
  // 否则额度恰好够的那次 `--dry-run` 会一路走到第 5 步,把"演习"变成真花钱。
  if (ctx.dryRun) {
    console.log(`  ${yellow('(--dry-run:到这里停 —— 再往下就是要花钱的交易了)')}`)
    ctx.stopped = true
    return
  }
  if (!ctx.didApprove) return

  // ⚠️ 授权**恰好等于**要付的金额,不是无限额度 —— 与人类路径一致
  // (`usePayFlow.ts:198-203`,args 就是 `[SPLITTER_ADDRESS, price]`)。
  // 差别是刻意的:签一个 `MaxUint256` 等于把以后每一次的授权都提前给了。
  ctx.approveHash = await send(
    ctx,
    { address: ctx.usdc, abi: erc20Abi, functionName: 'approve', args: [SPLITTER, ctx.amount] },
    '第 1 笔 · approve',
  )
}

/* ───────────────────────────── 第 5 步 ───────────────────────────── */

/** 发一笔写交易、等收据、报错说清楚。三处都要做,所以只有这一个出口 */
async function send(ctx, request, title) {
  let hash
  try {
    hash = await ctx.wallet.writeContract(request)
  } catch (e) {
    // ⚠️ 风险 W8-5:**RPC 抖动与"合约拒绝了"必须分开报**。
    // 吞成一个笼统的失败,演示现场就没法判断该重试还是该停下来看合约。
    const msg = String(e.shortMessage ?? e.message)
    const looksLikeRpc = /fetch failed|timeout|ECONNRESET|socket|503|429/i.test(msg)
    die(
      `${title} 没发出去:${msg}`,
      looksLikeRpc
        ? `  这看着像 RPC 的问题(网络/限流),不是合约拒绝。\n` +
            `  换端点重试:AGENT_RPC=https://avalanche-fuji-c-chain-rpc.publicnode.com node scripts/agent-buy.mjs`
        : `  这看着像链上的拒绝,不是网络问题。把上面那句原话读一遍再决定要不要重跑。`,
    )
  }
  console.log(`  ${dim(`${title} 已广播`)} ${hash}`)
  console.log(`  ${dim('  等上链…')} ${txLink(hash)}`)

  let receipt
  try {
    receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
  } catch (e) {
    die(
      `${title} 的交易已广播,但等收据超时/出错:${e.message}`,
      `  ⚠️ 这不等于失败 —— 交易可能已经在链上确认了。\n` +
        `  先去 explorer 看一眼,别急着重跑:${txLink(hash)}`,
    )
  }
  if (receipt.status !== 'success') {
    die(`${title} 上链了但执行失败(status = ${receipt.status})。`, `  看收据:${txLink(hash)}`)
  }
  // ⭐ 这个数值得单独打:脚本发的是**裸交易**,gasPrice 取节点建议;
  // 而浏览器钱包会自己加 1 nAVAX 的 tip —— 同一条 `pay()`,差 600 万倍。
  // 见 `shared/chain.ts` 的 `WALLET_DEFAULT_TIP`。演示时这两条路径的成本对比就靠它。
  field(
    'gasPrice',
    `${receipt.effectiveGasPrice} wei`,
    `实付 · 已用 ${receipt.gasUsed} gas · 见 ${txLink(hash)}`,
  )
  return hash
}

async function step5(ctx) {
  step(5, '付款 —— 自己调 CreatorSplitter.pay(contentId)')

  // ── gas 够不够(**不能按"钱包口径"算**,脚本不走钱包)────────
  // ⚠️ 估算走的是 **public client** + 显式 `account`:
  // `estimateContractGas` 是 public action,`createWalletClient` 上没有它
  // (钱包客户端只有 sign/send/write 那一族)。写错了是一句 `not a function`。
  const gasPrice = await ctx.client.getGasPrice()
  const payGas = await ctx.client.estimateContractGas({
    account: ctx.agent,
    address: SPLITTER,
    abi: [PAY_ABI],
    functionName: 'pay',
    args: [ctx.chosen.contentId],
  })
  const approveGas = ctx.didApprove
    ? await ctx.client.estimateContractGas({
        account: ctx.agent,
        address: ctx.usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [SPLITTER, ctx.amount],
      })
    : 0n
  // 多留 20% —— gas 估算与实际用量之间总有误差,而这笔钱小到不值得精算
  const needAvax = ((payGas + approveGas) * gasPrice * 12n) / 10n
  field(
    'gas 预估',
    `${formatUnits(needAvax, 18)} AVAX`,
    `${ctx.didApprove ? '2' : '1'} 笔 · ${payGas + approveGas} gas × ${gasPrice} wei × 1.2`,
  )
  if (ctx.avax < needAvax) {
    die(
      `AVAX 不够付 gas:有 ${formatUnits(ctx.avax, 18)},需要约 ${formatUnits(needAvax, 18)}。`,
      `  去 faucet 领一点。⚠️ 注意脚本的 gas 口径比钱包便宜 600 万倍\n` +
        `  (裸交易取节点建议价,钱包会自己加 1 nAVAX tip)—— 所以脚本说够,不代表网页上也够。`,
    )
  }

  const hash = await send(
    ctx,
    { address: SPLITTER, abi: [PAY_ABI], functionName: 'pay', args: [ctx.chosen.contentId] },
    ctx.didApprove ? '第 2 笔 · pay' : '第 1 笔 · pay',
  )
  ctx.txHash = hash
}

/* ───────────────────────────── 第 6 步 ───────────────────────────── */

async function step6(ctx) {
  step(6, '带着凭证重试 —— 同一个 URL,这次该给内容了')

  const q = ctx.quote
  // ⚠️ 五个字段**全是字符串**(`shared/agentPay.ts` 的 `parseXPayment` 逐个查),
  // 而且 `payer` 用的是**我自己的地址** —— 服务端会拿它和链上 `PaymentSplit` 的
  // `payer` 比,不一致就是 403 `payment_mismatch`。
  const header = JSON.stringify({
    txHash: ctx.txHash,
    payer: ctx.agent,
    quoteId: q.quoteId,
    expiresAt: String(q.expiresAt),
    sig: q.sig,
  })
  console.log(`  ${dim(`${PAYMENT_HEADER}: ${header.slice(0, 96)}…`)}`)

  // ⚠️ **必须是第 2 步那条完全相同的路径** —— 签名覆盖 contentId,
  // 换一条路径就验不过(那不是 bug,是"报价绑定内容"在生效,W7 §5.4 第 4 条)。
  const got = await call(ctx.path, { header })

  if (got.status !== 200) {
    const code = got.body?.error?.code ?? JSON.stringify(got.body).slice(0, 200)
    die(
      `期望 200,实得 ${got.status} ${code}`,
      `  常见的几个:\n` +
        `    payment_replayed   这笔 txHash 已经被兑过了 —— 换一件内容重跑\n` +
        `    payment_mismatch   凭证里的 payer 与链上那笔的 payer 不是同一个\n` +
        `    quote_invalid      凭证里的 sig / expiresAt 与报价不符\n` +
        `    payment_not_found  链上查不到这笔 txHash(RPC 读到了别的链?还没确认?)`,
    )
  }

  ctx.signedUrl = got.body.url
  ctx.urlExpiresIn = got.body.expiresInSeconds
  console.log(`  ${green('200 —— 内容交付了')}`)
  field('签名 URL', `${String(ctx.signedUrl).slice(0, 78)}…`, '短时效私有 blob 直链,与人类路径同一个形状')
  field('有效期', `${ctx.urlExpiresIn} 秒`, 'shared/unlock.ts 的 UNLOCK_URL_TTL_SECONDS')
}

/* ───────────────────────────── 第 7 步 ───────────────────────────── */

async function step7(ctx) {
  step(7, '真的下载一次 —— 证明拿到的不是个死链')

  let bytes
  try {
    const res = await fetch(ctx.signedUrl)
    if (!res.ok) die(`下载返回 ${res.status} ${res.statusText} —— 签名 URL 被拒了。`)
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    /**
     * ⚠️ **网络层不可达 ≠ 签名签错了。** 一定要分开报。
     *
     * 本机就会走到这里:私有 blob 的**数据面**主机
     * (`<storeid>.private.blob.vercel-storage.com`)从这台机器 ECONNRESET,
     * 而**控制面**(put / presign)是通的。所以"签名算得出来"能验,"字节下得来"不能。
     * 把它报成失败,会让人去改一段根本没坏的签名代码。
     */
    console.log(`  ${yellow('⚠️ 下载没成功,但这不是"链接坏了"')}`)
    console.log(dim(`      ${e.message}`))
    console.log(
      dim(
        `      本机的私有 blob 数据面是不可达的(见验证手段记录),所以这一步在本机永远下不来。\n` +
          `      换台机器 / 换网络跑就能下。在这之前,这一条算「没验」,不算「验不过」。`,
      ),
    )
    ctx.downloadOutcome = 'unreachable'
    return
  }

  ctx.bytes = bytes
  ctx.downloadOutcome = 'ok'
  console.log(`  ${green(`下载成功,${bytes.length} 字节`)}`)

  // ⚠️ `contentHash` 是内容文件的 **keccak256**(方案 §8.1 冻结的定义),
  // **不是 sha256** —— 用错原语会得到一个永远对不上的哈希,而且看不出为什么。
  const got = keccak256(bytes)
  field('keccak256', got, '本地算,与链上 contentHash 同一种原语')

  const content = await ctx.client.readContract({
    address: SPLITTER,
    abi: [GET_CONTENT_ABI],
    functionName: 'getContent',
    args: [ctx.chosen.contentId],
  })
  // 位置元组:`[creator, price, contentHash, recipients, splits, active]`
  const chainHash = content[2]
  if (got === chainHash) {
    field('链上 contentHash', green('一致 ✓'), '链上 getContent(…)[2] —— 拿到的就是当初上传的那份')
  } else {
    field('链上 contentHash', `${chainHash} ✗ 不一致`, '链上 getContent(…)[2]')
    die(
      '下载到的字节与链上登记的 contentHash 不一致。',
      `  要么内容被换过,要么中间有人改过。这条不该发生,记下来。`,
    )
  }
}

/* ───────────────────────────── 第 8 步 ───────────────────────────── */

function step8(ctx) {
  step(8, '收尾')

  console.log(`  这一趟做了什么:`)
  console.log(`    · 发现:从 /api/catalog 自己挑了 ${ctx.chosen.contentId}`)
  console.log(`    · 金额:从 402 的 accepts[0] 读了 ${formatUnits(ctx.amount, 6)} USDC`)
  console.log(`    · 交易:${ctx.didApprove ? 'approve + pay(2 笔)' : 'pay(1 笔,额度已够)'}`)
  console.log(`    · 交付:${ctx.path} → 200`)
  if (ctx.downloadOutcome === 'ok') console.log(`    · 内容:${ctx.bytes.length} 字节,keccak256 与链上一致`)

  console.log(`\n  ${bold('链上可验:')}`)
  console.log(`    ${txLink(ctx.txHash)}`)
  console.log(
    dim(
      `    ① 那笔交易的 PaymentSplit 事件里,payer 就是 ${ctx.agent}\n` +
        `    ② amounts 求和 == 该内容当时的链上价格\n` +
        `    ③ 看板 /dashboard 上这一笔带 [Agent] 徽章,分账明细与人类购买那一笔格式完全一样`,
    ),
  )

  console.log(`\n${bold('喂给 W7 的反例矩阵(机器可读):')}`)
  console.log(`txHash=${ctx.txHash}`)
  console.log(`payer=${ctx.agent}`)
}

/* ───────────────────────────── main ───────────────────────────── */

;(async () => {
  console.log(bold('SplitJar · Agent 自助付款演示'))
  console.log(dim(`  服务端 ${BASE_URL}   链 ${RPC}`))

  const ctx = {
    agent: null,
    client: createPublicClient({ transport: http(RPC) }),
    dryRun: DRY_RUN,
    didApprove: false,
    stopped: false,
  }

  ctx.agent = await step0(ctx)
  await step1(ctx)
  await step2(ctx)
  await step3(ctx)

  console.log(`\n${bold('前四步完成 —— 到这里为止一分钱没花,可以反复跑。')}`)

  await step4(ctx)
  if (ctx.stopped) {
    console.log(`\n${bold('--dry-run 结束。')}${dim('去掉这个参数就是真跑。')}`)
    return
  }
  await step5(ctx)
  await step6(ctx)
  await step7(ctx)
  step8(ctx)
})().catch((e) => {
  console.error(`\n${yellow('✗ 未预期的错误:')}${e.stack ?? e.message}`)
  process.exit(1)
})
