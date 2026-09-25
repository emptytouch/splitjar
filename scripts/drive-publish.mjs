#!/usr/bin/env node
/**
 * drive-publish.mjs —— 用**真浏览器**走一遍 `/create`,验 W14 D 组的发布链路。
 *
 * ## 为什么非要用浏览器(而不是再打一次 HTTP 接口)
 *
 * `scripts/verify-upload-targets.mjs` 验的是**服务端的门禁**:它证明了
 * "只授权 content 就写不了 preview"。但那一条**证不了客户端**:
 *
 * ```
 * ① `lib/previewDerive.ts` 真的能在浏览器里把一张图派生出来吗?
 *    (canvas + toBlob + 水印 —— 这三样在 Node 里一行都跑不了)
 * ② `usePublishFlow` 真的只用**一次签名**覆盖两个 store 吗?
 * ③ 两个 `directUpload` 真的各自落到了对的 store 吗?
 * ```
 *
 * ②尤其要拿证据:这次改动**唯一的目的**就是把发布时的钱包弹窗从两次减到一次。
 * 所以脚本会**数** `eth_signTypedData_v4` 被调用了几次 —— 必须是 **1**。
 *
 * ## 假钱包是怎么造的(wagmi v3 的一个硬要求)
 *
 * ⚠️ **只往 `window.ethereum` 上挂东西是没用的。** `src/lib/wagmi.ts` 的
 * `createConfig` 显式传了 `connectors`(没配 WalletConnect 时是空数组),
 * 于是 wagmi 的 `createConfig` **只从 EIP-6963 的 MIPD 注册表里发现钱包**,
 * 不再退回裸 `window.ethereum`。所以下面必须:
 *
 * ```
 * ① 在 `eip6963:requestProvider` 上挂一个监听器(这是 MIPD 主动要的方式)
 * ② 真发一个 `eip6963:announceProvider` 事件,detail 带 info + provider
 * ```
 *
 * 而**签名本身回到 Node 里做**(`page.exposeFunction`):这样私钥从头到尾
 * 只存在于一个 `privateKeyToAccount` 的返回值里,不进页面、不进日志。
 *
 * ## ⚠️ 它走到哪一步就停,以及为什么
 *
 * 它**故意不付 gas**:`eth_sendTransaction` 直接抛一个"测试钱包没有 gas"
 * 的错。于是流程停在 `creating`,而**那条失败文案本身就是证据** ——
 * 只有两个 blob 都传完了,`uploaded` 才会是 true,界面才会说
 * "文件已经传好了,重试会跳过上传"。
 *
 * ℹ️ 链上那笔 `createContent` **不是这次改动的一部分**(参数一个字没动),
 * 所以用一把没钱的临时钥匙去验它没有意义 —— 换来的是"gas 不足"这种
 * 与被验的东西无关的结论。
 *
 * 用法:
 *   # 两个窗口:vercel dev --listen 3000 / npm run dev
 *   node scripts/drive-publish.mjs [--url http://localhost:5173] [--headed]
 *
 * 退出码:0 = 全过;1 = 有失败。
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { getAddress } from 'viem'
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

/* ─────────────────── 造一张真 PNG 当内容 ==================== */

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

/**
 * 一张 2400×1600 的渐变图,**故意比 `PREVIEW_MAX_EDGE`(1200)大一倍** ——
 * 这样"派生时真的缩放了"才有证据(派生的图应该是 1200×800,不是 2400×1600)。
 *
 * 画斜条纹而不是纯渐变:水印是斜着平铺的,纯渐变底上很难看出它到底画上没有。
 */
function makeTestPng(width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const stripe = (x + y) % 180 < 90 ? 40 : 0
      raw[o++] = Math.min(255, Math.round((x / width) * 200) + stripe)
      raw[o++] = Math.min(255, Math.round((y / height) * 180) + stripe)
      raw[o++] = 210 - stripe
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

const SHOT_DIR = join(tmpdir(), 'splitjar-drive-publish')
mkdirSync(SHOT_DIR, { recursive: true })

/* ─────────────────── 把 harness 的私钥限制在 Node 里 ─────────────────── */

/**
 * ⚠️ **现生成一把临时钥匙**,不用任何真实钱包。
 * 它没有 gas —— 见文件头"走到哪一步就停"。没有任何真实资产与它相关。
 */
const account = privateKeyToAccount(generatePrivateKey())

/** 两位"协作者"的地址 —— 只是表单要合法地址,不参与签名 */
const collabA = getAddress(`0x${randomBytes(20).toString('hex')}`)
const collabB = getAddress(`0x${randomBytes(20).toString('hex')}`)

const contentFile = join(SHOT_DIR, 'test-content-2400x1600.png')
writeFileSync(contentFile, makeTestPng(2400, 1600))

console.log('drive-publish —— 真浏览器走一遍发布链路')
console.log(`  前端:${BASE_URL}`)
info(`临时钱包(无 gas,只用来签名): ${account.address}`)
info(`测试文件:${contentFile}(2400×1600 PNG)`)

/* ─────────────────── 观测点 ─────────────────── */

let signTypedDataCalls = 0
const uploadRequests = [] // 每一次打到 /api/upload 的请求体
const pageErrors = []
const consoleErrors = []

const browser = await chromium.launch({
  channel: 'msedge',
  headless: !HEADED,
  /**
   * ⚠️ 浏览器**必须**能出网 —— 客户端直传是把字节直接 PUT 到
   * `*.blob.vercel-storage.com`,不经过我们的 Function。本机唯一的出网
   * 机制是那个本地代理,而 playwright 的代理设置是浏览器级的。
   *
   * `bypass` 里必须排除 localhost,否则前端和 `/api` 的请求也会绕去代理。
   */
  proxy: { server: 'http://127.0.0.1:7897', bypass: 'localhost,127.0.0.1,::1' },
})

const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()

page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('request', (req) => {
  if (!req.url().includes('/api/upload')) return
  try {
    const body = JSON.parse(req.postData() ?? '{}')
    uploadRequests.push(body)
  } catch {
    uploadRequests.push({ _unparsed: req.postData() })
  }
})

/**
 * 页面 ↔ Node 的桥。**只暴露两件最小的事**:签一个 EIP-712、抛一个
 * "没有 gas"。别的一律不实现 —— 页面能做的越少,这个 harness 越不像
 * 一个能被误用的后门。
 */
await page.exposeFunction('__splitjarSignTypedData', async (typedDataJson) => {
  signTypedDataCalls++
  const td = JSON.parse(typedDataJson)
  // ⚠️ **类型定义直接用页面传过来的那一份**,不在 Node 里另抄一份 ——
  // 抄一份就等于多了一个"两边分叉"的机会,而分叉的症状是签名静默失效。
  // 唯一要动的是 `uint256`:JSON 里它是字符串,viem 要 bigint
  const message = { ...td.message }
  if (typeof message.deadline === 'string') message.deadline = BigInt(message.deadline)
  return await account.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message,
  })
})

await page.exposeFunction('__splitjarSendTransaction', async (txJson) => {
  const tx = JSON.parse(txJson)
  info(`eth_sendTransaction 被调到(to=${tx.to})—— 按设计在这里抛错`)
  const err = new Error('harness: 这是一把没有 gas 的临时钥匙,按设计不发这笔交易')
  err.code = -32000
  throw err
})

/**
 * 注入假钱包。
 *
 * ⚠️ 顺序很要紧:这段跑在**页面任何脚本之前**,所以它挂的
 * `eip6963:requestProvider` 监听器一定早于 wagmi 的 `createMipd()`。
 * MIPD 在初始化时会主动发一次 `requestProvider` —— 那才是钱包被发现的那一刻。
 * 同时也立刻广播一次,两条路都留着(顺序上哪条先到都不怕)。
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
      if (method === 'eth_sendTransaction') {
        return await window.__splitjarSendTransaction(JSON.stringify(params?.[0] ?? {}))
      }
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      if (method === 'wallet_getCapabilities') return {}
      // 其余一律按"不支持"回 —— 不认识的调用应该是响的,不是静默给个假答案
      const err = new Error(`harness: 未实现的方法 ${method}`)
      err.code = -32601
      throw err
    },
    // wagmi 的 injected connector 会订阅事件。harness 里一个都不发
    on() {},
    removeListener() {},
  }

  const info = {
    uuid: '11111111-2222-3333-4444-555555555555',
    name: 'SplitJar Harness',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    rdns: 'dev.splitjar.harness',
  }
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
  // 裸 window.ethereum 也挂上 —— wagmi 这一版不用它,但页面里别的东西
  // (比如某个库的探测)可能会看,挂上不亏
  window.ethereum = provider
}, { address: account.address })

/* ─────────────────── 开跑 ─────────────────── */

try {
  section('【1】连上假钱包')
  await page.goto(`${BASE_URL}/create`, { waitUntil: 'domcontentloaded' })

  /**
   * ⚠️ **不要假设"必须先点连接按钮"。**
   *
   * wagmi 的 `injected` connector 在 `setup()` 时会自己探一次 `eth_accounts`,
   * 非空就直接 emit `connect` —— 也就是说一个"已经登录"的钱包会**自动连上**,
   * 顶栏那个胶囊直接就显示短地址了,「连接钱包」这个按钮从来不存在。
   * (2026-09-25 实测:第一版脚本卡在等这个按钮上,而截图里钱包已经连好了。)
   *
   * 所以这里两条路都等着:已经连上就用,没连上就点一次。
   */
  const shortAddr = account.address.slice(0, 6)
  const connected = page.getByText(shortAddr).first()
  const connectBtn = page.getByRole('button', { name: /连接钱包/ }).first()

  await Promise.race([
    connected.waitFor({ timeout: 25000 }).catch(() => null),
    connectBtn
      .waitFor({ timeout: 25000 })
      .then(() =>
        connectBtn
          .click()
          .then(() =>
            page
              .getByRole('button', { name: /SplitJar Harness/ })
              .first()
              .click(),
          )
          .catch(() => null),
      )
      .catch(() => null),
  ])

  await connected.waitFor({ timeout: 20000 })
  ok('钱包连上了', account.address)

  section('【2】选文件 → 算指纹 + 派生预览图')
  await page.setInputFiles('#content-file', contentFile)

  // 指纹是一长串 0x…;等它出现说明哈希算完了
  const hashEl = page.getByText(/^0x[0-9a-f]{64}$/).first()
  await hashEl.waitFor({ timeout: 30000 })
  /** 页面上显示给创作者的那个指纹 —— 【8】要拿它跟真的落盘字节对一遍 */
  const shownHash = (await hashEl.textContent())?.trim() ?? null

  const previewImg = page.getByAltText('将要公开的预览图')
  await previewImg.waitFor({ timeout: 30000 })
  const dims = await previewImg.evaluate((el) => ({
    nw: el.naturalWidth,
    nh: el.naturalHeight,
  }))

  if (dims.nw === 1200 && dims.nh === 800) {
    ok('预览图派生出来了,且真的按长边缩到了 1200', `${dims.nw}×${dims.nh}(源图 2400×1600)`)
  } else {
    bad('预览图尺寸不对', `拿到 ${dims.nw}×${dims.nh},期待 1200×800`)
  }

  // 把它抓成字节看看到底是什么格式、多大
  const derived = await previewImg.evaluate(async (el) => {
    const res = await fetch(el.src)
    const blob = await res.blob()
    const buf = new Uint8Array(await blob.arrayBuffer())
    // PNG 的魔数 —— 用它可以判出"浏览器忽略了 webp 请求、回落成了 PNG"
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    const isWebp = buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    return { type: blob.type, bytes: blob.size, isPng, isWebp }
  })
  info(`派生出的字节:${derived.type} / ${derived.bytes} 字节 / PNG=${derived.isPng} WEBP=${derived.isWebp}`)

  if (derived.bytes > 0 && derived.bytes < 8 * 1024 * 1024) {
    ok('体积在预览图的上限(8 MiB)以内', `${(derived.bytes / 1024).toFixed(1)} KiB`)
  } else {
    bad('体积不对', `${derived.bytes} 字节`)
  }
  if (derived.isPng || derived.isWebp) {
    ok('是一张真的位图', derived.isWebp ? 'webp' : 'png(浏览器不支持 webp 编码时的正常回落)')
  } else {
    bad('抓到的不是位图', `${derived.type}`)
  }

  await page.screenshot({ path: join(SHOT_DIR, '01-picked.png') })

  section('【3】填表单并提交')
  await page.fill('#title', 'harness 验证用内容')
  await page.fill('#price', '0.2')
  // 两行协作者的地址;比例默认 70/20/10 已经合法
  const addrInputs = page.getByLabel('协作者地址')
  await addrInputs.nth(0).fill(collabA)
  await addrInputs.nth(1).fill(collabB)

  const submit = page.getByRole('button', { name: /^创建并上传/ })
  await submit.waitFor({ timeout: 10000 })
  // 按钮真的可点了才算表单填对了 —— 比自己去读 errors 更贴近用户看到的东西
  const enabled = await submit.isEnabled()
  if (enabled) ok('「创建并上传」可点了', '说明表单校验全过')
  else bad('「创建并上传」还是灰的', '表单没填对 —— 见下面的截图')

  await submit.click()

  section('【4】等它跑到"创建交易"那一步(两个 blob 都传完)')
  /**
   * ⚠️ 这一段是**整个脚本的证据所在**。
   *
   * 那条文案(`describePublishFailure` 里 `uploaded: true` 的分支)只有在
   * `state.uploaded` 为真时才出现,而 `uploaded` 是在**两个 `directUpload`
   * 都返回之后**才 dispatch 的。所以看到它就等于:内容传上去了、预览图也传上去了。
   */
  await page.getByText(/文件已经传好了/).first().waitFor({ timeout: 180000 })
  ok('流程停在创建交易那一步,且界面说"文件已经传好了"', '两个 blob 都传完才会出现这句话')

  /**
   * ⚠️ 光等文案出现还不够 —— **要证明它真的显示在用户眼前**。
   *
   * 2026-09-25 实测到过一次"文案在 DOM 里、截图里却看不到右栏内容",
   * 所以这里补两条:① 失败面板的标题必须是**可见**的;
   * ② 把页面上的正文原样打出来存档 —— 截图看不清的时候,文字是第二份证据。
   */
  const failedTitle = page.getByText('创建交易失败了').first()
  if (await failedTitle.isVisible()) {
    ok('失败面板是可见的,不是只躺在 DOM 里', '「创建交易失败了」')
  } else {
    bad('失败面板不可见', '文案在 DOM 里但用户看不到 —— 见 02 截图')
  }
  const visibleText = await page.evaluate(() => document.body.innerText)
  const hintLine = visibleText.split('\n').find((l) => l.includes('文件已经传好了'))
  info(`页面上的那句:${hintLine ?? '(没找到)'}`)
  if (!visibleText.includes('创建交易失败了')) {
    bad('页面正文里没有「创建交易失败了」', '拿到的正文见上面')
  }

  await page.screenshot({ path: join(SHOT_DIR, '02-after-uploads.png'), fullPage: true })

  section('【5】数签名:一次签名必须覆盖两个 store')
  if (signTypedDataCalls === 1) {
    ok('整次发布只弹了 1 次签名', '这就是这次改动的全部目的')
  } else {
    bad(`签名弹了 ${signTypedDataCalls} 次`, '期待 1 次(一次签名覆盖 content + preview)')
  }

  section('【6】两次上传各自打到对的 pathname')
  // 预检也打这个端点,所以它比上传多一次。按 pathname 去重看"碰过哪几条路径"
  const paths = new Set()
  for (const r of uploadRequests) {
    const p = r?.payload?.pathname ?? r?.pathname
    if (typeof p === 'string') paths.add(p)
  }
  const list = [...paths]
  info(`打过 /api/upload 的 pathname:${list.join(' , ') || '(一条都没抓到)'}`)

  const contentPath = list.find((p) => p.startsWith('content/'))
  const previewPath = list.find((p) => p.startsWith('preview/'))
  if (contentPath && previewPath && contentPath.slice('content/'.length) === previewPath.slice('preview/'.length)) {
    ok('两个 store 各写了一条,且 contentId 一致', contentPath)
  } else {
    bad('两次上传的 pathname 不对', `content=${contentPath} preview=${previewPath}`)
  }

  // 预检那条请求体里应当能看出授权**同时**列了两个 target
  const preflight = uploadRequests.find((r) => r?.type === undefined && typeof r?.targets !== 'undefined')
  if (preflight) {
    info(`预检的 targets = ${JSON.stringify(preflight.targets)}`)
    if (Array.isArray(preflight.targets) && preflight.targets.length === 2) {
      ok('预检带的授权里列了两个 target', JSON.stringify(preflight.targets))
    } else {
      bad('预检的 targets 不是两个', JSON.stringify(preflight.targets))
    }
  }

  // ── 页面报错 ──
  section('【7】页面上不该有我们没预期的报错')
  const expected = /gas|harness/i
  const unexpected = pageErrors.filter((e) => !expected.test(e))
  const unexpectedConsole = consoleErrors.filter((e) => !expected.test(e))
  if (unexpected.length === 0) ok('没有未预期的 pageerror')
  else bad(`有 ${unexpected.length} 条未预期的 pageerror`, unexpected.slice(0, 3).join(' | '))
  if (unexpectedConsole.length === 0) ok('没有未预期的 console.error')
  else bad(`有 ${unexpectedConsole.length} 条未预期的 console.error`, unexpectedConsole.slice(0, 3).join(' | '))

  // ── 把 contentId 交出去,让下面接着去查两个 store ──
  const contentId = contentPath ? contentPath.slice('content/'.length) : null
  await browser.close()

  section('【8】两个 blob 真的落在了各自的 store 里')
  if (!contentId) {
    bad('没抓到 contentId', '后面几步没法做')
  } else {
    await checkStores(contentId, shownHash)
  }
} catch (e) {
  bad('驱动过程中抛出', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  try {
    await page.screenshot({ path: join(SHOT_DIR, '99-crash.png') })
    console.log(`  崩溃截图=${join(SHOT_DIR, '99-crash.png')}`)
  } catch {
    /* 截图失败不该盖住真正的错 */
  }
  await browser.close()
}

console.log(`\n${'─'.repeat(60)}`)

/**
 * 直接问两个 store 要答案 —— **不看界面上说了什么,看字节在哪**。
 *
 * 这一段验三件事,每一件都是"界面说到"和"实际发生"之间的那道缝:
 *
 * ```
 * ① 预览图在**公开** store 里,而且**不需要任何凭证**就能取到
 *    (它就是给广场网格用的 —— 取不到等于那个功能是假的)
 * ② 内容在**私有** store 里,而且**不带凭证取不到**
 *    (这一条才是"付费墙"的物理形态。传到公开 store 就等于白送)
 * ③ 私有那份的 keccak256 **等于**页面上显示给创作者的那个指纹
 *    (②只证明"有个东西在那";③才证明"是那一份东西")
 * ```
 */
async function checkStores(contentId, shownHash) {
  const { list } = await import('@vercel/blob')
  const tokens = readLocalEnv()
  const publicToken = tokens.PUBLIC__READ_WRITE_TOKEN
  const privateToken = tokens.BLOB_READ_WRITE_TOKEN

  if (!publicToken || !privateToken) {
    bad('没从 .env.local 读到两个 blob 凭证', '这一步没法做')
    return
  }

  // ── ① 公开 store 里的预览图 ──
  const publicBlobs = await list({ token: publicToken, prefix: `preview/${contentId}` })
  const previewBlob = publicBlobs.blobs[0]
  if (!previewBlob) {
    bad('公开 store 里没有这条预览图', `preview/${contentId}`)
  } else {
    const res = await fetch(previewBlob.url)
    const type = res.headers.get('content-type') ?? ''
    const bytes = (await res.arrayBuffer()).byteLength
    if (res.ok && bytes > 0) {
      ok('预览图在公开 store,不带凭证就能取到', `HTTP ${res.status} / ${type} / ${bytes} 字节`)
    } else {
      bad('预览图取不到', `HTTP ${res.status} ${bytes} 字节`)
    }
    if (type.startsWith('image/')) {
      ok('公开 CDN 报的 content-type 是图片', type)
    } else {
      bad('content-type 不是图片 —— `<img>` 会不显示', `拿到 "${type}"`)
    }
  }

  // ── ② 私有 store 里的内容,以及它取不到 ──
  const privateBlobs = await list({ token: privateToken, prefix: `content/${contentId}` })
  const contentBlob = privateBlobs.blobs[0]
  if (!contentBlob) {
    bad('私有 store 里没有这条内容', `content/${contentId}`)
    return
  }
  ok('内容在私有 store 里', `content/${contentId}`)

  const anon = await fetch(contentBlob.url)
  if (anon.ok) {
    bad(
      '不带凭证就把付费内容取下来了',
      `HTTP ${anon.status} —— 这条内容等于公开,付费墙是假的`,
    )
  } else {
    ok('不带凭证取不到付费内容', `HTTP ${anon.status}`)
  }

  // ── ③ 字节的指纹 == 页面上给创作者看的那个 ──
  const authed = await fetch(contentBlob.url, {
    headers: { authorization: `Bearer ${privateToken}` },
  })
  if (!authed.ok) {
    bad('带凭证也取不到内容', `HTTP ${authed.status}`)
    return
  }
  const bytes = new Uint8Array(await authed.arrayBuffer())
  const { keccak256 } = await import('viem')
  const actual = keccak256(bytes)

  if (!shownHash) {
    bad('没读到页面上显示的指纹', '没法做③这一步的比对')
  } else if (actual.toLowerCase() === shownHash.toLowerCase()) {
    ok('落盘字节的 keccak256 等于页面上显示的指纹', `${actual.slice(0, 18)}…`)
  } else {
    bad('落盘的字节和页面上显示的指纹对不上', `页面 ${shownHash} / 实际 ${actual}`)
  }
}

/** 从 `.env.local` 里读两个 blob 凭证。**只读这一份文件,不碰别处** */
function readLocalEnv() {
  const out = {}
  let text
  try {
    text = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
  } catch {
    return out
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return out
}
if (failures.length === 0) {
  console.log(`✓ 全过(${passed} 项)。`)
  process.exit(0)
}
console.log(`✗ ${failures.length} 项失败 / 共 ${passed + failures.length} 项:`)
for (const f of failures) console.log(`   - ${f}`)
process.exit(1)
