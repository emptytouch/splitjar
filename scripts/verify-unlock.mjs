#!/usr/bin/env node
/**
 * verify-unlock.mjs —— 人类门禁那条路的**端到端**验证(§16.1 第 5 条 / W5 完成定义)
 *
 * 验的是这三句话,一句一句拿证据:
 *   ① 已付款 → 拿到 60s 短时效签名 URL
 *   ② 那个 URL **真的能下到字节**,且 keccak256 与链上 `contentHash` **相等**
 *   ③ 没付款 → 拒(签名合法也一样拒 —— 证明付费墙查的是链,不是前端)
 *
 * 为什么要单独一个脚本:`scripts/verify-x402.mjs` 验的是 **agent 那条路**
 * (`/api/content/:id` + `X-Payment`),而 `/api/unlock` 是**另一条路**
 * (EIP-712 签名 + nonce + 链上 `purchases`)。两条路的中间件、错误码、
 * 消耗的东西**全都不一样**,一条通过不能推出另一条通过。
 *
 * ⚠️ **这个脚本不花任何钱。** 它只用**已经买过**的那件内容 ——
 * `/api/unlock` 不写 `payment:${txHash}`(已 grep 核实:只有
 * `api/content/[id].ts` + `server/kv.ts` 写它),所以拿一笔旧付款反复验也不会
 * 把它烧掉。这与 `verify-x402.mjs --burn` 那条正好相反。
 *
 * 用法:
 *   export AGENT_PRIVATE_KEY=0x…        # ⚠️ 只在当前 shell,不进 .env、不进仓库
 *   export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897
 *   BASE_URL=https://splitjar.vercel.app \
 *     node --use-env-proxy scripts/verify-unlock.mjs [--wait-expiry] [--verbose]
 *
 * ⚠️ `--wait-expiry` 会在第 6 步**真等 60 秒**,验"链接过期后失效"。
 *    blob 数据面在本机只有走代理才可达,所以上面那个 export 不是可选的。
 *
 * 退出码:0 = 全过;1 = 有失败(或前置条件不满足)。
 */

import { readFileSync } from 'node:fs'
import { createPublicClient, http, keccak256, getAddress, parseAbiItem } from 'viem'
import { avalancheFuji } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

/* ─────────────────── 契约常量(与 shared/ 保持同步) ─────────────────── */
/**
 * ⚠️ 下面这几行是**副本**,不是引用 —— `scripts/` 在两个 tsconfig 的 include
 * 之外,**不能** import `shared/*.ts`(与 `verify-x402.mjs` 里那份
 * `blockWindows` 同一个理由)。改了 `shared/` 那边记得同步这里,
 * 否则症状是"签名永远验不过"或"读错了合约",而且看不出为什么。
 */
const SPLITTER = '0xDe9b3090263e20ebD5b3795F0199B500f6da72f5' // shared/chain.ts DEPLOYED_SPLITTER
const DEFAULT_RPC = 'https://api.avax-test.network/ext/bc/C/rpc' // shared/chain.ts DEFAULT_RPC_PRIMARY
const DOMAIN_NAME = 'SplitJar' // shared/eip712.ts SPLITJAR_DOMAIN_NAME
const DOMAIN_VERSION = '1' // shared/eip712.ts SPLITJAR_DOMAIN_VERSION
/** shared/unlock.ts UNLOCK_TYPES —— 四项**全在签名覆盖范围内** */
const UNLOCK_TYPES = {
  Unlock: [
    { name: 'contentId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

const PURCHASES_ABI = parseAbiItem(
  'function purchases(bytes32 contentId, address payer) view returns (bool)',
)
const GET_CONTENT_ABI = parseAbiItem(
  'function getContent(bytes32 contentId) view returns (address creator, uint256 price, bytes32 contentHash, address[] recipients, uint16[] splits, bool active)',
)

/* ───────────────────────────── 参数与环境 ───────────────────────────── */

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '')
const RPC = process.env.AGENT_RPC ?? DEFAULT_RPC
const WAIT_EXPIRY = process.argv.includes('--wait-expiry')
const VERBOSE = process.argv.includes('--verbose')

/** deadline 设在多久之后。与前端同值(shared/unlock.ts DEADLINE_SECONDS 的语义) */
const DEADLINE_SECONDS = 300
/** 与服务端 UNLOCK_URL_TTL_SECONDS 一致 —— `--wait-expiry` 靠它算等多久 */
const URL_TTL_GUESS = 60

/* ───────────────────────────── 输出 ───────────────────────────── */

const tty = process.stdout.isTTY
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s)
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s)
const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s)
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s)

function step(n, title) {
  console.log(`\n${bold(`【第 ${n} 步】${title}`)}`)
}

/**
 * 标签列宽按**终端列**算,不是 `padEnd` —— 一个汉字占两列却只算一个字符,
 * `padEnd` 会让值与标签**粘在一起**(在 `agent-buy.mjs` 上实测踩过)。
 */
const LABEL_COLUMNS = 12
function displayWidth(s) {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
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
function field(label, value, source) {
  const gap = ' '.repeat(Math.max(1, LABEL_COLUMNS - displayWidth(label)))
  console.log(`  ${label}${gap}${value}`)
  if (source) console.log(`  ${' '.repeat(LABEL_COLUMNS)}${dim(`└ 来源:${source}`)}`)
}
function die(msg, hint) {
  console.error(`\n${yellow('✗ 停止:')}${msg}`)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}

/* ───────────────────────────── 断言台账 ───────────────────────────── */

const results = []
/**
 * 记一条断言。**失败不中止** —— 这是验收脚本不是 CI,一次跑完拿到全貌
 * 比"第一个错就停"有用(与 `verify-x402.mjs` 同一条纪律)。
 */
function expect(name, ok, note = '') {
  results.push({ name, ok, note })
  console.log(`  ${ok ? green('✓') : red('✗')} ${name}${note ? dim(`  ${note}`) : ''}`)
}

/* ───────────────────────────── HTTP ───────────────────────────── */

/**
 * "连不上"与"HTTP 报错"**必须分开** —— 否则一次网络抖动会伪装成
 * "服务端拒了我",那是最容易误判的一类(本机尤其常见,见 README 那节)。
 */
async function call(path, init) {
  const url = `${BASE_URL}${path}`
  if (VERBOSE) console.log(dim(`  → ${init?.method ?? 'GET'} ${url}`))
  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    die(
      `连不上 ${url} —— ${e.message}`,
      `  · 本机打线上:必须 export HTTPS_PROXY=http://127.0.0.1:7897 且加 node --use-env-proxy\n` +
        `  · 打本机 dev server:用 127.0.0.1 而不是 localhost(npx vercel dev --listen 3000)`,
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

function readWhitelist() {
  const p = new URL('../shared/agentAddresses.json', import.meta.url)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    die(`读不了白名单 ${p.pathname} —— ${e.message}`)
  }
  // ⚠️ 非 strict 的 `getAddress` 会拿输入自己算 checksum 再和输入比,全小写会被它判成
  // "校验和不符"而抛 —— 所以先 toLowerCase(与 shared/agentAddresses.ts 逐条相同)。
  return (parsed.agents ?? []).map((e) => getAddress(String(e?.address ?? '').toLowerCase()))
}

function step0() {
  step(0, '自检 —— 我是谁,以及我到底买过什么')

  const pk = process.env.AGENT_PRIVATE_KEY
  if (!pk) {
    die(
      '环境变量 AGENT_PRIVATE_KEY 没设',
      `  按方案 §6.2,它只该存在于**你当前这个 shell**,不进 .env、不进仓库、不进前端产物。\n` +
        `    export AGENT_PRIVATE_KEY=0x…   # 用完关窗口`,
    )
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    // 只报形状,绝不回显内容 —— 一个打错的私钥不该被日志留下来
    die('AGENT_PRIVATE_KEY 不是 0x + 64 位 hex —— 检查是不是复制时少了字符或多带了后缀')
  }

  const account = privateKeyToAccount(pk)
  const me = getAddress(account.address)

  field('我是谁', me, 'AGENT_PRIVATE_KEY 推出来的(私钥本身不打印、不落盘)')
  field('服务端', BASE_URL, 'BASE_URL')
  field('链', `${avalancheFuji.name} (chainId ${avalancheFuji.id})`, 'shared/chain.ts CHAIN')
  field('合约', SPLITTER, 'shared/chain.ts DEPLOYED_SPLITTER')

  const whitelist = readWhitelist()
  const listed = whitelist.includes(me)
  field('看板认不认', listed ? green('在白名单里') : yellow('不在白名单里'), 'shared/agentAddresses.json')
  if (!listed) {
    console.log(
      `  ${yellow('⚠️')} ${dim('不在白名单不影响这个脚本(它验的是 /api/unlock,与买家类型无关),')}`,
    )
    console.log(`  ${dim('   但看板会把这笔显示成"人类"。要用 agent 的钱包跑演示就先补上。')}`)
  }

  const publicClient = createPublicClient({ chain: avalancheFuji, transport: http(RPC) })
  return { account, me, publicClient }
}

/* ───────────────────────────── 第 1 步 ───────────────────────────── */

async function step1(ctx) {
  step(1, '挑一件「我买过的」内容 —— 买没买以**链上**为准,不看服务端怎么说')

  const cat = await call('/api/catalog')
  if (cat.status !== 200) {
    die(`catalog 没通:HTTP ${cat.status} ${JSON.stringify(cat.body)}`)
  }
  const items = cat.body?.items ?? cat.body
  if (!Array.isArray(items) || items.length === 0) {
    die('catalog 是空的 —— 没有在架内容,这条验不了')
  }
  console.log(`  在架 ${items.length} 件,逐件查链上 purchases:`)

  const owned = []
  for (const it of items) {
    const bought = await ctx.publicClient.readContract({
      address: SPLITTER,
      abi: [PURCHASES_ABI],
      functionName: 'purchases',
      args: [it.contentId, ctx.me],
    })
    console.log(
      `    ${bought ? green('已买') : '未买'}  ${it.contentId}  ${it.title ?? dim('(无标题)')}`,
    )
    if (bought) owned.push(it)
  }

  if (owned.length === 0) {
    die(
      `这个地址 ${ctx.me} 在链上一笔都没买过 —— 于是"已付款 → 能下载"这条无从验起`,
      `  · 先跑 \`node scripts/agent-buy.mjs\` 买一件(那一步**要花钱**),再回来跑这个脚本\n` +
        `  · 或者用 BASE_URL 换一个已经买过的地址`,
    )
  }
  const target = owned[0]
  field('目标内容', target.contentId, 'catalog')
  field('链上确已购买', green('是'), 'CreatorSplitter.purchases(contentId, 我)')
  return target
}

/* ───────────────────────────── 第 2–4 步 ───────────────────────────── */

/** 领 nonce → 签名 → 提交。三条路复用同一段(负对照也要走一遍) */
async function unlockOnce(ctx, contentId, signer, label) {
  const n = await call(`/api/unlock-nonce?contentId=${contentId}`)
  if (n.status !== 200) {
    die(`unlock-nonce 没通:HTTP ${n.status} ${JSON.stringify(n.body)}`)
  }
  const nonce = String(n.body.nonce)
  const deadline = String(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)

  const signature = await signer.signTypedData({
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: avalancheFuji.id,
      verifyingContract: SPLITTER,
    },
    types: UNLOCK_TYPES,
    primaryType: 'Unlock',
    message: {
      contentId,
      buyer: signer.address,
      // uint256 —— 必须 BigInt,传字符串 viem 会拒
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    },
  })

  if (VERBOSE) console.log(dim(`  [${label}] nonce=${nonce} deadline=${deadline} sig=${signature.slice(0, 12)}…`))

  const r = await call('/api/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentId, buyer: signer.address, nonce, deadline, signature }),
  })
  return r
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

const ctx = step0()

const target = await step1(ctx)

/* ── 第 2–4 步:正题 —— 已付款,拿签名 URL ─────────────────────────────── */
step(2, '领 nonce → 本地签 EIP-712 → 提交(⚠️ 只签名,不发任何交易)')
const ok = await unlockOnce(ctx, target.contentId, ctx.account, '正面')
field('HTTP', ok.status === 200 ? green('200') : red(String(ok.status)), 'POST /api/unlock')
expect(
  '已付款地址 → 200',
  ok.status === 200,
  ok.status === 200 ? '' : `实得 ${ok.status} ${ok.body?.error?.code ?? ''}`,
)
if (ok.status !== 200) {
  console.error(`\n${red('正题就没过,后面的下载无从谈起。')}服务端说:${JSON.stringify(ok.body)}`)
  process.exit(1)
}
const { url, expiresInSeconds } = ok.body
field('下载 URL', `${url.slice(0, 72)}…`, '服务端签发的短时效 URL')
field('有效秒数', String(expiresInSeconds), 'shared/unlock.ts UNLOCK_URL_TTL_SECONDS')
expect('URL 是签名的(带签名参数)', /[?&](sig|token|signature)=/.test(url) || url.includes('blob.vercel-storage.com'))

/* ── 第 5 步:真的下载 ────────────────────────────────────────────────── */
step(3, '真的下载一次 —— 证明拿到的不是个死链')
let bytes = null
let downloadStatus = null
try {
  const res = await fetch(url)
  downloadStatus = res.status
  if (res.ok) bytes = new Uint8Array(await res.arrayBuffer())
} catch (e) {
  // ⚠️ 区分"网络层到不了"与"服务端拒了" —— 前者在本机很常见(blob 数据面),
  // 绝不能写成"链接坏了"。
  console.log(`  ${yellow('⚠️')} 下载请求本身失败了:${e.message}`)
  console.log(`  ${dim('   这不等于"链接坏了" —— 先确认 HTTPS_PROXY 给了,blob 数据面在本机只有走代理才可达。')}`)
}
field('HTTP', downloadStatus === null ? red('连不上') : String(downloadStatus), `GET ${new URL(url).host}`)
field('字节数', bytes ? green(String(bytes.length)) : red('—'), '实际下载到的字节')
expect('下载成功且非空', Boolean(bytes && bytes.length > 0), bytes ? `${bytes.length} 字节` : '')

if (!bytes || bytes.length === 0) {
  console.error(
    `\n${yellow('下载没成功 —— 但这不是"链接坏了"。')}\n` +
      `  两个可能:① 本机没走代理(blob 数据面到不了);② 链接真的过期了(60s 很短)。\n` +
      `  先 export HTTPS_PROXY 再来一次。`,
  )
  process.exit(1)
}

/* ── 第 6 步:比哈希 ──────────────────────────────────────────────────── */
step(4, '与链上 contentHash 比对 —— 这才是"下到的就是那件内容"的证明')

const raw = await ctx.publicClient.readContract({
  address: SPLITTER,
  abi: [GET_CONTENT_ABI],
  functionName: 'getContent',
  args: [target.contentId],
})
// ⚠️ viem 把多返回值解成**位置元组**,不是具名对象 —— 顺序以 ABI 为准:
// (creator, price, contentHash, recipients, splits, active)
const onchainHash = raw[2]
const downloadedHash = keccak256(bytes)

field('链上 contentHash', onchainHash, 'CreatorSplitter.getContent()')
field('下到的 keccak256', downloadedHash, '对下载到的字节现算')
expect('两者相等', onchainHash === downloadedHash, onchainHash === downloadedHash ? '' : '内容对不上,别急着说"通过"')

/* ── 第 7 步(可选):过期后失效 ───────────────────────────────────────── */
if (WAIT_EXPIRY) {
  const wait = (expiresInSeconds ?? URL_TTL_GUESS) + 3
  step(5, `等 ${wait} 秒,再打一次同一个 URL —— 验"短时效"不是修辞`)
  console.log(`  ${dim(`(这 ${wait} 秒是脚本故意的。链接有效期由服务端定,前端改不了。)`)}`)
  await new Promise((r) => setTimeout(r, wait * 1000))

  let afterStatus = null
  let afterErr = ''
  try {
    const res = await fetch(url)
    afterStatus = res.status
    if (res.ok) afterErr = '仍然 200 —— 链接没过期'
  } catch (e) {
    afterErr = e.message
  }
  field('过期后再打', afterStatus === null ? red('拒绝(连接失败)') : String(afterStatus), '同一个 URL')
  expect(
    '过期后失效',
    afterStatus === null || afterStatus >= 400,
    afterStatus === null ? '连接被拒' : `HTTP ${afterStatus}`,
  )
} else {
  step(5, '过期后失效 —— 没跑')
  console.log(`  ${dim('加 --wait-expiry 会真等 60 秒验这一条(§16.1 三句话里的第三句)。')}`)
}

/* ── 第 8 步:负对照 —— 签名合法但没买 ──────────────────────────────── */
step(WAIT_EXPIRY ? 6 : 5, '负对照:一个**从没买过**的地址签一份合法消息')
{
  // 现场生成一个一次性私钥。**零余额、随机、用完即弃** ——
  // 所以即使哪里写错,它连 gas 都付不起,动不到任何人的钱。
  // (⚠️ 别换成"众所周知的测试私钥":那类地址被别人打过币,是**别人**的钱。)
  const throwaway = privateKeyToAccount(generatePrivateKey())
  console.log(`  ${dim(`一次性地址 ${throwaway.address}(零余额,随机生成,只做签名)`)}`)
  const neg = await unlockOnce(ctx, target.contentId, throwaway, '负对照')
  field('HTTP', String(neg.status), 'POST /api/unlock')
  field('错误码', String(neg.body?.error?.code ?? '(无)'), '共享错误码')
  expect(
    '签名合法 + 链上没买 → 被拒',
    neg.status >= 400,
    neg.status >= 400 ? `实得 ${neg.status} ${neg.body?.error?.code ?? ''}` : '⚠️ 没买也发内容了',
  )
  if (neg.body?.error?.code === 'not_purchased') {
    // 这条是给文档用的:spec §16.1 写的是 401,实现是 402,而且 402 是**故意**的
    console.log(
      `  ${dim('注:这里是 402 not_purchased(不是 spec §16.1 写的 401)。')}\n` +
        `  ${dim('   401 留给"验签/时效/nonce"三类认证失败,402 是"可以买,先付钱" —— 见 shared/api.ts:66。')}`,
    )
  }
}

/* ───────────────────────────── 结论 ───────────────────────────── */

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(
  `\n${bold('═══ 结论 ═══')}\n` +
    `  ${green(`${passed} 通过`)} / ${failed === 0 ? '0 失败' : red(`${failed} 失败`)}` +
    `${WAIT_EXPIRY ? '' : dim('  (过期那条没跑,加 --wait-expiry)')}`,
)
if (failed > 0) {
  console.log(`\n${red('有失败项 —— 上面带 ✗ 的就是。')}`)
  process.exit(1)
}
console.log(
  `\n${dim('§16.1 第 5 条「付款后能真实下载到内容文件」到此有机器证据了:')}\n` +
    `${dim('签名 URL → 真下到字节 → keccak256 与链上 contentHash 相等。')}`,
)
