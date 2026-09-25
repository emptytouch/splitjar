#!/usr/bin/env node
/**
 * drive-dashboard.mjs —— 用**真浏览器**走一遍内容看板(`/dashboard`)。
 *
 * 原名 `drive-backfill.mjs`。2026-09-26 改名,因为这一节「标题从哪来」
 * 加进来之后,它验的就不再只是「补预览图」那一件事,而是**这一页能不能信**。
 *
 * ```
 * 【1b】标题        —— 四个来源状态各画各的
 * 【1】-【8】补预览图 —— 看板上那一行的入口
 * ```
 *
 * ## 它验的是哪条路
 *
 * 预览图上传失败**不挡发布**(见 `lib/previewDerive.ts`),于是存在一种内容:
 * 链上好好的、买家买得到、广场上那一格却是空的。`/create` 在那个失败里给的
 * 承诺("入口在内容看板")靠看板那一行兑现 —— 这个脚本就是去点那行。
 *
 * 要验的几件事,一件比一件难用接口验:
 *
 * ```
 * ① `usePreviews` 的**三态**真的成立吗?
 *    "不知道"(服务端 503 / 读失败)时**一个入口都不该画** ——
 *    画了就是让创作者在一个不缺缩略图的内容上白签一次名。这条只有浏览器能验:
 *    它取决于 react-query 的 error 分支怎么落到 `urls === null` 上。
 * ② 核对指纹那一步真的**在签名之前**吗?
 *    证据是 `eth_signTypedData_v4` 的调用次数必须是 **0**,而且公开 store 里
 *    的 blob 数一个都不许多。
 * ③ 派生那张图在真浏览器里能不能出来?(canvas + toBlob —— Node 里跑不了)
 * ④ 这条路上"离开浏览器"的三个动作(`authorizeUpload` / `preflightUpload` /
 *    `directUpload`)接得对不对?—— 拿真服务端的回应当证据。
 * ⑤(`【1b】`)标题的**四个状态**分不分得开,以及它会不会**自己**从
 *    "还在路上"变成真的 —— 后者是"合并有没有被搬回 `queryFn`"的唯一判据
 *    (见 `useMyContents.ts` 文件头 2026-09-26 那段)。
 * ```
 *
 * ⚠️ 【1b】的每一条都要求**全新整页 navigate**:`['catalog']` 一旦有缓存,
 * 就再也读不到"读失败"那一态,那时验的是缓存不是分支。
 *
 * ## ⚠️ 顺带量到的一件事:`/api/catalog` 在本机要 5~13 秒
 *
 * 2026-09-26 实测(`curl --noproxy '*' -w '%{time_total}'`):
 *
 * ```
 * :3000/api/catalog   200  16.3s / 12.9s / 5.6s / 5.6s
 * :5173/api/catalog   200  11.2s
 * :3000/api/catalog   503  45.2s   ← 只在"函数进程没带代理"的那次
 * ```
 *
 * 内容是对的(`title` 就是「苹果图」),只是慢 —— 它在服务端**扫了一遍链**。
 * 这件事决定了看板上的观感:**冷启动时标题位会先是一个占位块,几秒后才变成真标题**。
 * 所以这个脚本里的等待都给得比一般的长(90 秒)。
 *
 * ⚠️ **那个 503/45 秒不是这个端点的性质,是本机环境** —— `vercel dev` 的函数
 * 进程不走系统代理(WinINET 那套它读不到),要 `NODE_USE_ENV_PROXY=1` 才有。
 * 同一台机器、同一个端点,加上那个变量之后是 **5.5~12.9 秒、四次全 200**。
 * ⚠️ 而**线上**(`splitjar.vercel.app/api/catalog`)实测约 **0.7 秒** ——
 * 所以**别拿本机这些数字去推断线上的体验**,更别据此去"优化"这个端点。
 *
 * ⚠️ **别把等待改短** —— 那不会让产品变快,只会让这个脚本开始随机失败。
 *
 * ## ⚠️ 它**证不了**的那一段(必须说清楚)
 *
 * **补图的 happy path(`ready → working → done`)没有被走通。**
 *
 * 原因是硬的,而且是**产品本身的安全性质**,不是这个脚本的偷懒:
 * 要走到 `done`,连着钱包的那个地址必须同时是
 *
 * ```
 * ① 链上记录的 creator —— 否则 `useMyContents` 里根本没有这一行
 * ② 那把私钥的持有者 —— 否则服务端第 ③ 步(签名核对)必挂
 * ③ 而且这一条在服务端是用**真 RPC** 查的(第 ⑤ 步:链上归属)——
 *    它跑在 Node 里,浏览器伪造不了
 * ```
 *
 * ⚠️ 第三条是关键:**即使用浏览器把日志和账户都伪造成"这件内容归我",
 * 第 ⑤ 步仍然会在服务端拿真链去对**,然后回 403 `content_claimed`。
 * 也就是说这一段"验不了"正是"服务端真的在核归属"的证据。
 *
 * 而**本仓库里没有这样一把钥匙** —— 那两件真内容属于两个我们没有私钥的地址
 * (也不能有:见 `.env.example` 里"部署私钥绝不写进 .env"那条)。
 *
 * 所以脚本走到最后停在**一次真实的失败**上,而那次失败本身就是证据:
 * 它证明这条链路真的把请求发到了服务端(服务端回的那个 401 是它自己的判断)。
 * 与 `drive-publish.mjs` 停在"没有 gas"是同一个手法。
 *
 * ## 假钱包是怎么造的
 *
 * 与 `drive-publish.mjs` 同一套(EIP-6963,只挂 `window.ethereum` 没用 ——
 * wagmi 走的是 MIPD 注册表)。**唯一的不同是地址**:
 * 这里 `eth_accounts` 返回的是**真的创作者地址**,因为看板按它过滤。
 * 签名仍然回 Node 里做,而 Node 里那把钥匙是**随机生成的临时钥匙** ——
 * 也就是说"连着谁"和"谁在签"是**刻意错开的**,最后一节的失败正来自这个错开。
 *
 * ## 链上输入有一处是伪造的(【6】)
 *
 * `ContentRegistered.contentHash` 是**非索引**字段,落在 log 的 `data` 第一个字里。
 * 【6】把那个字改成全零,复现"创建于上传功能之前"的那一类内容(链上指纹是
 * 零值 → 核对不了 → 任何能派生出图的文件都能过)。
 *
 * ⚠️ **被验的仍然是我们的代码**:伪造的只是"链回答了零值"这个输入,
 * 而那是一个**真实会出现的**输入(老内容)。这一节验的是
 * `isVerifiableHash` 那条分支、`HASH_UNVERIFIED_NOTE` 那段文案、
 * 以及 `PreviewPanel` 的复用有没有生效。
 * 真链上现在这两件内容都是新式的(指纹非零),所以【6】只能靠伪造输入。
 *
 * 用法(不需要 export 代理 —— 出网由浏览器自己的 `proxy` 设置负责):
 *   node scripts/drive-dashboard.mjs [--url http://localhost:5173] [--headed]
 *
 * 退出码:0 = 全过;1 = 有失败。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { keccak256, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

/* ─────────────────── 断言 ─────────────────── */

let passed = 0
const failures = []

function ok(label, detail) {
  passed++
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail) {
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}
function info(msg) {
  console.log(`    · ${msg}`)
}
function section(title) {
  console.log(`\n${title}`)
}

/* ─────────────────── 真链上的两件内容(写死的夹具) ─────────────────── */
/**
 * ⚠️ 这两个值是**真的**,从 Fuji 上读来的:
 *
 *   curl -s localhost:3000/api/catalog                                 # 拿 contentId
 *   cast call $SPLITTER 'getContent(bytes32)' $ID --rpc-url $FUJI      # 拿 creator/contentHash
 *
 * 链上的东西会变(内容下架、又发布了新的),所以脚本会**先确认它们还成立**,
 * 不成立就带着一句"重新读一次"退出 —— 而不是拿过期的夹具跑出一堆看不懂的错。
 */
const FIXTURE = {
  contentId: '0x91ffa52904458ab4ec58b7c68d5955b00ddde99dc59efb415fcc1499b26f5a48',
  creator: '0xAa05f6809B1f358e53f2c1D65A75eD6b7aAd0bba',
  /** 链上记的指纹 —— 【5】要拿它的前 10 个字符去对界面上的证据 */
  contentHash: '0x5178052e37405b983810b7a16c2b0559bb7c1bdb2e2152cf728daded931ce3a3',
  title: '苹果图',
}

/**
 * `ContentRegistered(bytes32,address,bytes32,uint256)` 的 topic0。
 *
 * 在 Node 里现算,而不是抄一串字面量 —— 抄错了的症状是"拦截器以为这是
 * 别的日志、一个字节都没改",而那种失败看起来跟"这条分支没生效"一模一样。
 * (已与 `contracts/out/CreatorSplitter.sol/CreatorSplitter.json` 里的 abi
 * 对过:两边算出来是同一个值。)
 */
const CONTENT_REGISTERED_TOPIC = keccak256(
  toHex('ContentRegistered(bytes32,address,bytes32,uint256)'),
)

/* ─────────────────── 造一张真 PNG ─────────────────── */
/** 与 `drive-publish.mjs` 同一份(那边已经跑通过,不另写一套位图编码) */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 一张 900×600 的条纹图。**故意不是**那份原件 —— 它的 keccak256 一定要对不上 */
function makeTestPng(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0
    for (let x = 0; x < width; x++) {
      const stripe = (x * 3 + y * 5) % 140 < 70 ? 55 : 0
      raw[o++] = Math.min(255, 30 + stripe)
      raw[o++] = Math.min(255, Math.round((x / width) * 190))
      raw[o++] = Math.min(255, 200 - stripe)
      raw[o++] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ─────────────────── 命令行参数 ─────────────────── */

const argv = process.argv.slice(2)
const urlArg = argv.indexOf('--url')
const BASE_URL = (urlArg >= 0 ? argv[urlArg + 1] : null) ?? 'http://localhost:5173'
const HEADED = argv.includes('--headed')

const SHOT_DIR = join(tmpdir(), 'splitjar-drive-dashboard')
mkdirSync(SHOT_DIR, { recursive: true })

/**
 * ⚠️ **现生成一把临时钥匙**,不用任何真实钱包 —— 它没有 gas、没有任何资产。
 * 它和 `FIXTURE.creator` **不是同一个地址**(也做不到),见文件头那段。
 */
const account = privateKeyToAccount(generatePrivateKey())

const pickedFile = join(SHOT_DIR, 'wrong-file-900x600.png')
writeFileSync(pickedFile, makeTestPng(900, 600))

console.log('drive-dashboard —— 真浏览器走一遍内容看板(标题 + 补预览图)')
console.log(`  前端:${BASE_URL}`)
info(`看板连的地址(真创作者): ${FIXTURE.creator}`)
info(`实际签名的钥匙(临时,故意错开): ${account.address}`)
info(`要补的那一件:${FIXTURE.contentId.slice(0, 18)}…(catalog 里叫「${FIXTURE.title}」)`)
info(`准备喂进去的文件:${pickedFile}(900×600,故意不是原件)`)

/* ─────────────────── 观测点 ─────────────────── */

let signTypedDataCalls = 0
const uploadRequests = [] // 打到 /api/upload 的请求体
/** `/api/upload` 的每一次回应状态码 —— 【7】要拿 401 当"服务端真的核了签名"的证据 */
const uploadStatuses = []
const pageErrors = []
const consoleErrors = []

/** `/api/previews` 的拦截模式 —— 见【2】【4】 */
let previewsMode = 'real'

/**
 * `/api/catalog` 的拦截模式 —— 见【1b】。
 *
 * `slow` 是**挂住不答**(不是延迟 N 秒):【1b】要用它把标题钉在 `pending`
 * 那一态上,而"等够久"这种写法会随链上扫描的快慢飘。
 */
let catalogMode = 'real'
/**
 * 放行那一个被 `slow` 挂住的请求。**非 `null` 就等于"拦截器正挂在里面"**
 * —— 赋值发生在 promise 执行器里,是同步的,所以这个判断没有竞态。
 */
let catalogRelease = null
/**
 * 拦截器对 `/api/catalog` 的每一次处置 —— **只在断言失败时打**。
 *
 * 2026-09-26 加:第一次跑【1b】就在这里翻了车 —— 放行之后标题一直没变,
 * 而界面只是**空着**(占位块那种低对比度的一块),不给任何线索区分
 * "请求还挂着" / "浏览器把那一枪掐了" / "respond 了但组件没收"。
 * 这个日志就是那个区分。
 */
const catalogLog = []

/**
 * 真的 `/api/catalog` 响应体 —— **`slow` 那一态要拿它当"迟到的真话"**。
 *
 * ⚠️ 用 Node 自己的 `fetch`,**不是** `route.fetch()`。2026-09-26 实测:
 * 在 `page.route` 的 handler 里调 `route.fetch()` 会**从这个 handler 再进来一次**
 * (同一个 url pattern),于是第一次调用永远等不到 —— 症状是"标题一直空着,
 * 而且拦截器的日志一个字都没有"。Node 自己发就没这个问题。
 *
 * 只取一次并缓存:这个端点在**服务端扫链**,本机一次要 5~13 秒(见文件头),
 * 每用一次都重取会把脚本拖成十几分钟。
 */
let catalogBodyCache = null
/**
 * ⚠️ 2026-09-26 本机实测:`200 / 15.2s`、`200 / 11.2s`、**`503 / 45.2s`**。
 * 最后那个 503 是**本机函数的代理环境**问题(见文件头),不是这个端点的性质
 * —— 补上 `NODE_USE_ENV_PROXY=1` 之后四次全是 200。
 *
 * 但脚本**不该**假设环境一定正常(这一条今天已经翻过一次车),所以取三次、
 * 给足超时。取不到就返回 `null`,让调用方**明说"这一条没验成"**,
 * 而不是让请求永远挂着 —— 挂着看起来像"标题一直空着",能把人带偏(已发生过一次)。
 */
async function catalogBody() {
  if (catalogBodyCache !== null) return catalogBodyCache
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now()
    try {
      const res = await fetch(new URL('/api/catalog', BASE_URL), {
        signal: AbortSignal.timeout(120_000),
      })
      const text = await res.text()
      info(
        `取真目录 第 ${i} 次:${res.status},${((Date.now() - t0) / 1000).toFixed(1)} 秒,${text.length} 字节`,
      )
      if (res.ok) {
        catalogBodyCache = text
        return text
      }
    } catch (e) {
      info(`取真目录 第 ${i} 次:${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return null
}

/** 是否把 `ContentRegistered` 里的 contentHash 那个字改成零 —— 见【6】 */
let zeroContentHash = false
/** 上面那件事只报一次(见拦截器里的注释) */
let zeroHashReported = false

const browser = await chromium.launch({
  channel: 'msedge',
  headless: !HEADED,
  /** 与 `drive-publish.mjs` 同一个理由:客户端直传要能出网,而本机唯一的
   *  出网机制是那个本地代理。`bypass` 必须排除 localhost,否则 /api 也会绕过去 */
  proxy: { server: 'http://127.0.0.1:7897', bypass: 'localhost,127.0.0.1,::1' },
})

const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const page = await context.newPage()

page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('request', (req) => {
  if (!req.url().includes('/api/upload')) return
  try {
    uploadRequests.push(JSON.parse(req.postData() ?? '{}'))
  } catch {
    uploadRequests.push({ _unparsed: req.postData() })
  }
})
page.on('response', (res) => {
  if (res.url().includes('/api/upload')) uploadStatuses.push(res.status())
})

/** 页面 ↔ Node 的桥。只暴露"签一个 EIP-712",别的什么都不给 */
await page.exposeFunction('__splitjarSignTypedData', async (typedDataJson) => {
  signTypedDataCalls++
  const td = JSON.parse(typedDataJson)
  // 类型定义直接用页面传过来的那一份 —— 在 Node 里另抄一份就是多一个
  // "两边分叉"的机会,而分叉的症状是签名静默失效(同 drive-publish)
  const message = { ...td.message }
  if (typeof message.deadline === 'string') message.deadline = BigInt(message.deadline)
  return await account.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message,
  })
})

/* ─────────────────── 拦截器 ─────────────────── */

/**
 * 【2】【4】—— 直接改 `/api/previews` 的**回应**,用来把 hook 逼到另外两态上。
 *
 * 这是这个脚本里唯一一处"造数据",而它造的正是最难自然复现的那两个输入:
 * 公开 store 没配(503)、以及"这一件确实有图"。
 */
await page.route('**/api/previews', async (route) => {
  if (previewsMode === '503') {
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not_configured' }),
    })
  }
  if (previewsMode === 'with-target') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        previews: { [FIXTURE.contentId.toLowerCase()]: 'https://example.invalid/preview/x' },
      }),
    })
  }
  return route.continue()
})

/**
 * 【1b】—— `/api/catalog` 是**看板标题的唯一服务端来源**(见
 * `lib/contentMeta.ts` 的 `resolveTitle`)。这里三态各造一个输入:
 *
 * ```
 * slow     挂住不答       → 标题该是占位块(pending),不是「未命名内容」
 * 503      读失败         → 该是「标题读不到」(unknown),不是「未命名内容」
 * no-title 200,但这份没有  → 这才该显示「未命名内容」(none)—— 四态里唯一
 *            标题            允许说这四个字的那一态
 * ```
 *
 * ⚠️ 这三个输入**都会走一遍真的 `openDashboard()`**(整页 navigate),
 * 不是在同一次会话里改 mode。理由是 react-query 的缓存:同一次会话里
 * `['catalog']` 已经有 data 了,再把它改成 503 也读不到失败那一态 ——
 * 那样验的就不是"读失败时画什么",而是"缓存还在时画什么"。
 */
await page.route('**/api/catalog', async (route) => {
  if (catalogMode === 'slow') {
    /**
     * ⚠️ 这里挂的是**回包**,不是请求本身 —— 真响应在脚本这边先取回来
     * (见 `catalogBody()`),浏览器那一枪一直停在"已发出、在等回应"上。
     *
     * 2026-09-26 实测:直接把这个 handler `await` 住(既不发也不回),
     * 放行之后**拿不到结果** —— 标题永远停在"还在路上"。改挂回包之后
     * 放行是**立刻**生效的,不用再等一趟服务端。
     */
    const body = await catalogBody()
    if (!body) {
      catalogLog.push('真目录没取到')
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'upstream_unavailable' }),
      })
    }
    await new Promise((r) => {
      catalogRelease = r
    })
    catalogLog.push('放行')
    try {
      return await route.fulfill({ status: 200, contentType: 'application/json', body })
    } catch (e) {
      catalogLog.push(`回包时失败:${e.message}`)
      return
    }
  }
  if (catalogMode === '503') {
    catalogLog.push('503')
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'upstream_unavailable' }),
    })
  }
  if (catalogMode === 'no-title') {
    catalogLog.push('no-title')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            contentId: FIXTURE.contentId,
            title: null,
            price: '50000',
            currency: 'USDC',
            decimals: 6,
            chainId: 43113,
            creator: FIXTURE.creator,
            previewUrl: null,
          },
        ],
        blockNumber: '0',
      }),
    })
  }
  return route.continue()
})

/**
 * 【6】—— 把 `eth_getLogs` 回来的 `ContentRegistered` 日志里 contentHash 那个字
 * 改成全零。
 *
 * 事件形状:`(contentId indexed, creator indexed, contentHash, price)`,
 * 所以非索引的那两个字段在 `data` 里是**两个字**,第一个就是 contentHash。
 *
 * ⚠️ 只改**筛了这个 topic 的那次查询** —— 同一个 provider 还会查
 * `PaymentSplit`(它的 `data` 里是金额),无差别地清第一个字会把金额改掉。
 */
await page.route(/avax-test\.network|publicnode\.com/, async (route) => {
  const body = route.request().postData()
  if (!zeroContentHash || !body || !body.includes('eth_getLogs')) return route.continue()

  let topics
  try {
    topics = JSON.parse(body)?.params?.[0]?.topics
  } catch {
    return route.continue()
  }
  if (topics?.[0] !== CONTENT_REGISTERED_TOPIC) return route.continue()

  const res = await route.fetch()
  const json = await res.json()
  let edited = 0
  for (const log of json.result ?? []) {
    // data = 0x + 64 位(contentHash)+ 64 位(price)
    if (typeof log?.data !== 'string' || log.data.length < 2 + 128) continue
    log.data = log.data.slice(0, 2) + '0'.repeat(64) + log.data.slice(2 + 64)
    edited++
  }
  /**
   * ⚠️ **一次查询返回 0 条日志是正常的** —— `useMyContents` 会打好几次
   * `eth_getLogs`(内容、上下架、分账各一次),只有内容那一次有东西。
   * 所以这里只在"第一次真的改到了"时报一声,别把噪音当成异常刷屏。
   */
  if (edited > 0 && !zeroHashReported) {
    zeroHashReported = true
    info(`拦截器把 ${edited} 条 ContentRegistered 的 contentHash 清成了零值`)
  }
  return route.fulfill({ response: res, json })
})

/**
 * 注入假钱包。与 `drive-publish.mjs` 完全相同,唯一不同的是地址来源 ——
 * 这里必须是**真的创作者**(看板按它过滤)。
 */
await context.addInitScript(({ address }) => {
  const provider = {
    isSplitJarHarness: true,
    async request({ method, params }) {
      if (method === 'eth_chainId' || method === 'net_version') {
        return method === 'net_version' ? '43113' : '0xa869'
      }
      if (method === 'eth_accounts') return [address]
      if (method === 'eth_requestAccounts') return [address]
      if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
        const p = params ?? []
        return await window.__splitjarSignTypedData(
          typeof p[1] === 'string' ? p[1] : JSON.stringify(p[1] ?? p[0]),
        )
      }
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      if (method === 'wallet_getCapabilities') return {}
      const err = new Error(`harness: 未实现的方法 ${method}`)
      err.code = -32601
      throw err
    },
    on() {},
    removeListener() {},
  }

  const walletInfo = {
    uuid: '11111111-2222-3333-4444-666666666666',
    name: 'SplitJar Harness',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    rdns: 'dev.splitjar.harness',
  }
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info: walletInfo, provider }),
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
  window.ethereum = provider
}, { address: FIXTURE.creator })

/* ─────────────────── 小工具 ─────────────────── */

/** 页内打一次 `/api/previews`(会被上面的拦截器影响,所以只在 real 模式下用) */
async function previewCount() {
  return await page.evaluate(async () => {
    const res = await fetch('/api/previews')
    const body = await res.json().catch(() => null)
    return { status: res.status, count: Object.keys(body?.previews ?? {}).length }
  })
}

/**
 * 页内直连那次请求现在**还通不通**。
 *
 * ⚠️ 只在**断言失败时**打 —— 用来把两种失败分开:"网络这一腿断了"
 * 与"服务端返回正常、但组件没画出来"。没有这一枪,后者会被误报成前者
 * (2026-09-26 就撞过一次:【3】超时,而截图里那一行干干净净,
 * 看起来像"组件没画",其实是那一枪根本没发出去)。
 */
async function probePreviews() {
  return await page.evaluate(async () => {
    try {
      const res = await fetch('/api/previews')
      const body = await res.json().catch(() => null)
      return { status: res.status, keys: Object.keys(body?.previews ?? {}).length }
    } catch (e) {
      return { status: 'throw', msg: e instanceof Error ? e.message : String(e) }
    }
  })
}

/**
 * 看板那一行的标题位**现在到底是什么**。
 *
 * 【1b】失败时打一枪。截图能看出"有没有字",看不出"是占位块还是空着"
 * —— 那个占位块是低对比度的灰块(`bg-surface-2` 落在 `bg-surface-2/40`
 * 的行底上),截图里几乎看不出来。
 */
async function probeTitleSlot() {
  return await page.evaluate(() => {
    const li = document.querySelector('li.rounded-xl')
    const slot = li?.querySelector('p > span.truncate')
    return {
      skeleton: Boolean(slot?.querySelector('[aria-label="标题载入中"]')),
      text: (slot?.textContent ?? '').trim(),
    }
  })
}

/** 等那一行的「补预览图」入口出现/不出现 */
const backfillBtn = () => page.getByRole('button', { name: /^补预览图$/ })

/**
 * 定位那一行 —— **按 contentId 的前 18 位**,不按标题。
 *
 * ⚠️ 2026-09-26 实测:看板上这一行显示的是「未命名内容」,而
 * `GET /api/catalog` 给的标题是「苹果图」。**不拿标题当定位器** ——
 * 标题是服务端 KV 里的东西,可以变、也可以缺(见 `CatalogEntry.title`),
 * 而 contentId 是链上事实。用标题定位会让这个脚本的失败原因
 * 看起来像"夹具过期了",而真正的原因是别处。
 */
const rowId = () => page.getByText(FIXTURE.contentId.slice(0, 18), { exact: false }).first()

/** 这一个地址的看板应该只有一行 —— 多一行说明夹具的归属变了 */
async function openDashboard() {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' })
  await rowId().waitFor({ timeout: 40000 })
}

/* ─────────────────── 开跑 ─────────────────── */

try {
  section('【1】用真创作者的地址连上看板')
  await openDashboard()

  const shortAddr = FIXTURE.creator.slice(0, 6)
  const connected = page.getByText(shortAddr).first()
  if (await connected.isVisible().catch(() => false)) {
    ok('钱包自动连上了(注入的 eth_accounts 非空,wagmi 的 setup 会自己连)', FIXTURE.creator)
  } else {
    // 没自动连就点一次 —— 不假设一定是哪条路(同 drive-publish)
    const connectBtn = page.getByRole('button', { name: /连接钱包/ }).first()
    await connectBtn.click()
    await page.getByRole('button', { name: /SplitJar Harness/ }).first().click()
    await connected.waitFor({ timeout: 20000 })
    ok('点了一次连接,钱包连上了', FIXTURE.creator)
  }

  const rows = await page.locator('li.rounded-xl').count()
  if (rows === 1) ok('看板只有这一行', '归属过滤是对的')
  else bad('这一行的数量不对', `拿到 ${rows} 行,夹具可能过期了`)

  /** 【3】要用:公开 store 现在到底有多少张图 —— 全程不许变 */
  const before = await previewCount()
  info(`公开 store 现在的预览图数:${before.status} / ${before.count} 张`)
  if (before.status === 200) ok('GET /api/previews 是 200')
  else bad('GET /api/previews 不是 200', `${before.status} —— 公开 store 的凭证可能没配`)
  if (!before.count || before.count === 0) {
    info('ℹ️ 公开 store 里一张都没有 —— 【3】的"没变"这次没有区分力,但不算失败')
  }

  /**
   * ⚠️ **这一枪要等几秒到几十秒** —— `/api/catalog` 在服务端扫链(见文件头)。
   * 等它到,`01-dashboard.png` 才是"标题这个 bug 修好之后"的样子;
   * 不等就是一个空白标题位,看起来像"改坏了"。
   */
  try {
    await page.getByText(FIXTURE.title).first().waitFor({ timeout: 90000 })
    ok('冷启动最后读到了服务端那份标题', `「${FIXTURE.title}」—— 全新 profile,本机没记过它`)
  } catch {
    bad('等了 90 秒也没读到服务端那份标题', '见 【1b】的诊断,以及文件头那段端点时延')
  }
  await page.screenshot({ path: join(SHOT_DIR, '01-dashboard.png') })

  /* ──【1b】标题:服务端那一份说了算,而且读不到时不许乱说 ─────────── */
  section('【1b】标题 —— 四态各画各的(这一节守两个 bug)')

  /**
   * ⚠️ 这一节的前身是一次**实测出来的**不一致:同一件内容、同一时刻,
   * 广场显示「苹果图」、看板显示「未命名内容」—— 因为看板只读本机
   * localStorage,而这台机器从来没发布过它。playwright 每次都是全新
   * profile,**localStorage 一定是空的**,所以这里跑到「苹果图」
   * 就只可能来自服务端那一份。
   */
  catalogMode = 'slow'
  /**
   * ⚠️ **先把真目录取回来,再开页面。** 反过来的话,拦截器要一边挂着
   * 浏览器的请求一边等十几秒的服务端,而下面那个"闸门"就是在这十几秒
   * 之后才立起来的 —— 第一版给 5 秒、第二版给 40 秒,都被这一次扫链
   * 顶掉了(实测有一次 45.2 秒才回)。先取回来,闸门就是**立刻**立起来的。
   */
  const slowBody = await catalogBody()
  if (!slowBody) {
    bad('服务端目录三次都没给 200', '【1b】"还在路上"那一段这次没验成 —— 端点自己不稳')
  }
  await openDashboard()

  /**
   * ⚠️ **`pending` 与 `unknown` 必须画得不一样。** 这一条是整节里最容易
   * 被"优化"掉的:合并成一句兜底能少写一个分支,代价是标题先显示
   * 「标题读不到」、半秒后变成真标题 —— 这一页会自己改口。
   */
  const skeleton = page.getByLabel('标题载入中')
  try {
    await skeleton.first().waitFor({ timeout: 15000 })
    const lies = await page
      .getByText(/未命名内容|标题读不到/)
      .count()
    if (lies === 0) ok('目录还在路上时画的是占位块', '没有抢先说「未命名内容」或「标题读不到」')
    else bad('目录还没到就先把话说死了', `出现了 ${lies} 处兜底文案`)
  } catch {
    const probe = await page.evaluate(async () => {
      const res = await fetch('/api/catalog').catch(() => null)
      return res ? `status ${res.status}` : 'fetch 抛了'
    })
    bad('没等到标题占位块', `页内那一枪的状态:${probe}`)
  }
  await page.screenshot({ path: join(SHOT_DIR, '01b-title-pending.png') })

  /**
   * 放行被挂住的那一个请求 —— 标题应当**自己**变成真的。
   *
   * ⚠️ 等用的是**轮询上限**而不是 `await` 那一个 promise:上面那条断言
   * 万一是失败路径(占位块压根没画出来),`await` 会在这个脚本最需要
   * 它报错的时候把它**吊死**,而吊死看起来像"卡住了",不像"这条不对"。
   *
   * ⚠️ 上限给到 40 秒,因为拦截器要先**从真服务端把目录取回来**才设这个闸门,
   * 而那个端点要 10 秒上下(见 `catalogBody`)。第一版给 5 秒 —— 于是闸门
   * 还没设好就先放弃了,症状是"标题一直空着、日志一个字都没有"。
   */
  for (let i = 0; i < 400 && !catalogRelease; i++) await page.waitForTimeout(100)
  if (catalogRelease) {
    catalogRelease()
    catalogRelease = null
  } else {
    info('ℹ️ 拦截器没进到 slow 分支 —— 后面几条断言会因为"标题没变"而失败,原因在这')
  }

  try {
    await page.getByText(FIXTURE.title).first().waitFor({ timeout: 15000 })
    ok('目录到了之后标题是服务端那一份', `「${FIXTURE.title}」`)

    /**
     * ⭐ **这一条才是真正的回归守卫。**
     *
     * 标题的两个来源是在 `useMyContents` 的 `useMemo` 里合的(不在
     * `queryFn` 里)—— 因为链上那份查询的 `queryKey` 只跟地址有关,
     * 它**不会**因为 catalog 后到而重跑。要是谁把合并搬回 `queryFn`,
     * 这里就会**永远停在占位块上**:占位块在,真标题永远不来。
     * 那不是"看起来有点慢",是那一行再也不会说真话。
     */
    if ((await skeleton.count()) === 0) ok('占位块被真标题换掉了', '合并发生在 queryFn 之外')
    else bad('真标题到了、占位块还在', '合并八成又搬回 queryFn 里了')
  } catch {
    bad(
      '放行之后标题没变成服务端那一份',
      `等的是「${FIXTURE.title}」;这一行的现状 ${JSON.stringify(await probeTitleSlot())}` +
        `;拦截器的处置:${JSON.stringify(catalogLog)}`,
    )
  }

  /** 分享链接里那个 `?t=` 只在**真拿到标题**时才该出现(见 `sharePath`) */
  const href = await rowId().getAttribute('href')
  if (href && href.includes(encodeURIComponent(FIXTURE.title))) {
    ok('分享链接带上了标题', href)
  } else {
    bad('分享链接里的 `?t=` 不对', `拿到 ${href}`)
  }
  if ((await page.getByText('未命名内容').count()) === 0) {
    ok('整页没有一处「未命名内容」', '这一态现在是真的,不该出现在这里')
  } else {
    bad('有标题却仍然画了「未命名内容」')
  }
  await page.screenshot({ path: join(SHOT_DIR, '01b-title-server.png') })

  /* ── 目录读失败:说"读不到",不许说"没有" ─────────────────────────── */
  catalogMode = '503'
  await openDashboard()
  try {
    await page.getByText('标题读不到').first().waitFor({ timeout: 20000 })
    /**
     * ⚠️ 方案 §14.2 的判据是**这两句话不许混**:「读不到」是在陈述我们的
     * 处境,「未命名内容」是在陈述内容本身 —— 后者是我们**不知道**的事。
     */
    if ((await page.getByText('未命名内容').count()) === 0) {
      ok('目录读了 503 时显示「标题读不到」', '而不是替服务端断言"这件内容没有标题"')
    } else {
      bad('读失败被画成了「未命名内容」', '§14.2 明令禁止把读失败显示成没有数据')
    }
  } catch {
    bad('503 时既没有「标题读不到」也没有别的说明')
  }
  if ((await skeleton.count()) === 0) ok('重试走完之后占位块收了')
  else bad('isError 之后还挂着占位块', 'pending 与 error 没有分开')
  await page.screenshot({ path: join(SHOT_DIR, '01b-title-unknown.png') })

  /* ── 服务端说"这份没有标题"—— 四态里唯一该说那四个字的一态 ─────────── */
  catalogMode = 'no-title'
  await openDashboard()
  try {
    await page.getByText('未命名内容').first().waitFor({ timeout: 15000 })
    ok('服务端明说没有标题时才显示「未命名内容」', '这一态是它唯一该出现的地方')
  } catch {
    bad('服务端返回 title: null 时没有显示「未命名内容」')
  }
  const hrefNoTitle = await rowId().getAttribute('href')
  if (hrefNoTitle && !hrefNoTitle.includes('?t=')) {
    ok('没有标题时不拼 `?t=`', '空参数会让链接多出一个没有含义的差异')
  } else {
    bad('没有标题却拼出了 `?t=`', `拿到 ${hrefNoTitle}`)
  }
  catalogMode = 'real'

  /* ──【2】"不知道"的时候,一个入口都不许画 ───────────────────────── */
  section('【2】`/api/previews` 回 503 时 —— "不知道"不等于"没有"')
  previewsMode = '503'
  await openDashboard()
  await page.waitForTimeout(2500) // 给 react-query 的 error 分支落定

  if ((await backfillBtn().count()) === 0) {
    ok('一个「补预览图」都没有', '服务端说"我没配公开 store",界面就当自己不知道')
  } else {
    bad('503 时仍然画出了「补预览图」', '这一条正是 usePreviews 文件头在防的事')
  }
  await page.screenshot({ path: join(SHOT_DIR, '02-503-no-entry.png') })

  /* ──【3】"确实没有"才画 ─────────────────────────────────────────── */
  section('【3】真的没有缩略图时 —— 入口出现')
  previewsMode = 'real'
  await openDashboard()
  try {
    /**
     * ⚠️ 60 秒,而且**不是为了宽容** —— 这个服务和 `/api/catalog` 一样要在
     * 服务端扫链,本机冷的时候几十秒(见文件头)。判据是"入口最后有没有出现",
     * 不是"它多快出现";上一次这一条超时的时候,同一行里的入口在后面几节里
     * 明明在(【7】的面板文字里有「广场上这一件没有缩略图」),
     * 所以那是等待太短,不是缺陷。
     */
    await backfillBtn().first().waitFor({ timeout: 60000 })
    ok('那一行上出现了「补预览图」', '链上看板确实没读过这一件的预览图')
  } catch {
    const probe = await probePreviews()
    bad(
      '入口没出现',
      `页内直连 /api/previews = ${JSON.stringify(probe)} —— 若是 200 且不含这一件,` +
        '说明问题在组件那一侧;若是别的,说明是这一枪没发出去',
    )
  }

  const hint = await page.getByText('不影响买卖,只是买家不好认', { exact: false }).count()
  if (hint > 0) ok('入口旁边把"这不是故障"说清楚了')
  else bad('没有看到"不影响买卖"那句说明')

  await page.screenshot({ path: join(SHOT_DIR, '03-entry.png') })

  /* ──【4】"确实有"也不画 ─────────────────────────────────────────── */
  section('【4】这一件已经有缩略图时 —— 入口消失')
  previewsMode = 'with-target'
  await openDashboard()
  await page.waitForTimeout(2500)
  if ((await backfillBtn().count()) === 0) {
    ok('入口没了', '判据是那个映射里有没有这个 id,而且键统一小写')
  } else {
    bad('已经有预览图了还是画出了入口', '创作者会白签一次名,然后收到一句会骗人的失败')
  }

  /* ──【5】选一个对不上的文件 —— 本地就拒,零次签名 ───────────────── */
  section('【5】选错文件 —— 签名之前就停下')
  previewsMode = 'real'
  await openDashboard()
  await backfillBtn().first().click()

  const fileInput = page.locator(`#preview-file-${FIXTURE.contentId}`)
  await fileInput.waitFor({ timeout: 10000 })
  await fileInput.setInputFiles(pickedFile)

  const mismatch = page.getByText('这个文件不是这一份内容', { exact: false })
  await mismatch.first().waitFor({ timeout: 30000 })
  ok('界面明说"这个文件不是这一份内容"', '而不是"校验失败"这种吓人的说法')

  const onchainPrefix = FIXTURE.contentHash.slice(0, 10)
  const panelText = await page.locator('li.rounded-xl').first().innerText()
  if (panelText.includes(onchainPrefix)) {
    ok('把两个指纹的前几位都摆出来了', `链上记的是 ${onchainPrefix}…`)
  } else {
    bad('面板里没有链上那个指纹的前缀', `找不到 ${onchainPrefix}`)
  }
  const pickedHash = keccak256(new Uint8Array(makeTestPng(900, 600)))
  if (panelText.includes(pickedHash.slice(0, 10))) {
    ok('选中的那个文件的指纹也在', `${pickedHash.slice(0, 10)}…`)
  } else {
    bad('面板里没有选中文件的指纹', `找不到 ${pickedHash.slice(0, 10)}`)
  }

  if (signTypedDataCalls === 0) {
    ok('一次签名都没弹', 'eth_signTypedData_v4 调用数 = 0')
  } else {
    bad('弹了钱包', `signTypedData 被调了 ${signTypedDataCalls} 次 —— 核对没有排在签名之前`)
  }

  const afterMismatch = await previewCount()
  if (afterMismatch.count === before.count) {
    ok('公开 store 里的 blob 数没变', `还是 ${afterMismatch.count} 张`)
  } else {
    bad('blob 数变了', `${before.count} → ${afterMismatch.count}`)
  }
  if (uploadRequests.length === 0) {
    ok('一个字节都没往 /api/upload 发')
  } else {
    bad('居然发出了上传请求', `${uploadRequests.length} 次`)
  }

  await page.screenshot({ path: join(SHOT_DIR, '04-mismatch.png') })

  /* ──【6】伪造输入:链上指纹是零值的那一类 ───────────────────────── */
  section('【6】链上指纹为零值(创建于上传功能之前)—— 能走到 ready')
  if (signTypedDataCalls !== 0) info(`⚠️ 上一节已经弹过 ${signTypedDataCalls} 次签名,这一节从头再来`)

  zeroContentHash = true
  await openDashboard()
  await page.waitForTimeout(1500)
  await backfillBtn().first().click()
  await page.locator(`#preview-file-${FIXTURE.contentId}`).setInputFiles(pickedFile)

  const previewImg = page.getByAltText('将要公开的预览图')
  try {
    await previewImg.waitFor({ timeout: 30000 })
    const dims = await previewImg.evaluate((el) => ({
      nw: el.naturalWidth,
      nh: el.naturalHeight,
    }))
    ok('派生出来的图摆在创作者面前了', `${dims.nw}×${dims.nh}(源图 900×600)`)
  } catch {
    bad('没等到预览图', '零值指纹这一支没走到 ready —— 见下面的截图')
  }

  const unverified = await page.getByText('没法核对', { exact: false }).count()
  if (unverified > 0) {
    ok('明说了"这一件核对不了"', '不说等于让创作者以为这张图被验过了')
  } else {
    bad('没有看到"没法核对"那段提示')
  }

  const confirm = page.getByRole('button', { name: '确认上传' })
  if (await confirm.isEnabled().catch(() => false)) {
    ok('「确认上传」是亮的', '说明状态机停在 ready 而不是自动往下走')
  } else {
    bad('「确认上传」点不动')
  }

  if (signTypedDataCalls === 0) {
    ok('仍然一次签名都没弹', '选文件本身不碰钱包 —— 要等他点确认')
  } else {
    bad('选文件就弹了钱包', `signTypedData 被调了 ${signTypedDataCalls} 次`)
  }

  // 【5】那一节滚动过,这里滚回这一行的顶部再拍 —— 不然截到的是上一屏
  await page.getByRole('button', { name: '确认上传' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOT_DIR, '05-ready.png'), fullPage: false })

  /* ──【7】点「确认上传」—— 走到真服务端 ──────────────────────────── */
  section('【7】点「确认上传」—— 走到真服务端,拿它的判断当证据')
  await confirm.click()

  // 走到失败为止。文案是哪一条**由真服务端的回应决定**,这里只等面板出现
  const failed = page
    .getByText(/预览图没能传上去|请求没被接受|这份内容不归当前这个钱包/)
    .first()
  await failed.waitFor({ timeout: 60000 })

  /** 面板的整段文字 —— 标题 + 提示 + 细节 + 按钮,一次拿全 */
  const failPanel = await failed
    .locator('xpath=ancestor::div[1]')
    .innerText()
    .catch(async () => (await failed.textContent()) ?? '')
  info(`界面上的失败面板:${failPanel.split('\n').map((l) => l.trim()).filter(Boolean).join(' / ')}`)

  if (signTypedDataCalls >= 1) {
    ok('钱包被弹了一次(而且只该有一次)', `eth_signTypedData_v4 × ${signTypedDataCalls}`)
  } else {
    bad('压根没签名', '说明流程没走到 authorizeUpload')
  }

  const wireReq = uploadRequests.find((b) => typeof b?.signature === 'string')
  if (wireReq) {
    const targets = wireReq.targets
    if (Array.isArray(targets) && targets.length === 1 && targets[0] === 'preview') {
      ok('这条授权只覆盖 preview 一个 store', JSON.stringify(targets))
    } else {
      bad('授权范围不对', JSON.stringify(targets))
    }
    if (wireReq.uploader?.toLowerCase() === FIXTURE.creator.toLowerCase()) {
      ok('uploader 是链上那个创作者', wireReq.uploader)
    } else {
      bad('uploader 不对', String(wireReq.uploader))
    }
  } else {
    bad('没有抓到带签名的 /api/upload 请求体')
  }

  /**
   * ⭐ **这一条是【7】最硬的证据。**
   *
   * 那个 401 是服务端 `api/upload.ts` 第 ③ 步(签名核对)回的 ——
   * 这条新链路真的把请求发到了服务端,而且是**服务端**在拒绝,
   * 不是前端自己拦下来的。
   *
   * ## ⚠️ 它是被**预检**挡下的,所以 PUT 那一段没跑到
   *
   * 实测状态码序列只有 `[401]` **一个** —— 也就是说 `preflightUpload` 那一枪
   * 就被拒了,`directUpload` 压根没发出去。这不是缺陷,**恰恰是设计想要的**:
   * ③ 在预检里,坏消息就能带着服务端自己的理由回到界面
   * (`postJson` 读得到 body),而不是等到 PUT 之后变成 SDK 那句
   * 不读响应体的 "Failed to retrieve the client token"(见 `lib/uploadApi.ts`)。
   * 界面上的「签名与上传者地址不符」就是服务端那句话本身。
   */
  if (uploadStatuses.includes(401)) {
    ok('服务端在预检那一步就回了 401(第 ③ 步)', `状态码序列 ${uploadStatuses.join(' → ')}`)
  } else {
    bad('没有看到 401', `状态码序列 ${uploadStatuses.join(' → ') || '(空)'}`)
  }
  if (wireReq?.type === undefined && uploadStatuses.length === 1) {
    ok('PUT 那一段没有发出(预检提前拦下了)', '所以 `directUpload` 这条腿这次仍未被走到')
  } else {
    info(`/api/upload 一共 ${uploadStatuses.length} 次 —— PUT 那一段${
      uploadStatuses.length > 1 ? '走过了' : '没走到'
    }`)
  }
  if (failPanel.includes('签名与上传者地址不符')) {
    ok('服务端自己那句理由原样到了界面上', '预检读得到 body —— 正是它存在的理由')
  } else {
    bad('界面上没有服务端那句理由', '说明这次失败又变成了笼统的"网络问题"')
  }

  const afterUpload = await previewCount()
  if (afterUpload.count === before.count) {
    ok('公开 store 里的 blob 数仍然没变', `还是 ${afterUpload.count} 张 —— 一次真失败没留下垃圾`)
  } else {
    bad('blob 数变了', `${before.count} → ${afterUpload.count}`)
  }

  await page.screenshot({ path: join(SHOT_DIR, '06-server-refused.png') })

  /* ── 收尾 ────────────────────────────────────────────────────────── */
  section('【8】页面有没有报错')
  // RPC / 控制台的噪音不算 —— 只看真正的未捕获异常
  if (pageErrors.length === 0) {
    ok('没有任何未捕获的页面异常')
  } else {
    bad('页面抛了异常', pageErrors.slice(0, 3).join(' | '))
  }
  info(`控制台 error 共 ${consoleErrors.length} 条(前 3 条):`)
  for (const e of consoleErrors.slice(0, 3)) console.log(`      ${e.slice(0, 160)}`)
} catch (e) {
  bad('脚本自己崩了', e instanceof Error ? e.message : String(e))
  await page.screenshot({ path: join(SHOT_DIR, '99-crash.png') }).catch(() => {})
} finally {
  await browser.close()
}

/* ─────────────────── 汇总 ─────────────────── */

console.log(`\n${'='.repeat(64)}`)
if (failures.length === 0) {
  console.log(`✓ 全过(${passed} 项)。「补预览图」这条收尾路径成立。`)
  console.log('\n⚠️ 仍然没有验到的那两段(见文件头):')
  console.log('   ① `directUpload` 的 PUT 腿 —— 这次被预检提前拦下了,没跑到')
  console.log('   ② `done` —— 需要一把"既持有私钥、又拥有链上内容"的钥匙')
  console.log('      最后那道墙是服务端第 ⑤ 步(链上归属):它用真 RPC,浏览器伪造不了')
  if (signTypedDataCalls > 0) {
    console.log(`   (本次走到了签名那一步:eth_signTypedData_v4 × ${signTypedDataCalls},`)
    console.log('    失败来自"连着的地址"与"签名的钥匙"刻意错开 —— 服务端第 ③ 步签名核对)')
  }
  console.log(`\n截图:${SHOT_DIR}`)
  process.exit(0)
} else {
  console.log(`✗ ${failures.length} 项失败(${passed} 项通过):`)
  for (const f of failures) console.log(`   - ${f}`)
  console.log(`\n截图:${SHOT_DIR}`)
  process.exit(1)
}
