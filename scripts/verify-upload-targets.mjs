#!/usr/bin/env node
/**
 * verify-upload-targets.mjs —— W14 D 组的**安全回归**:
 * `Upload.target: string` → `Upload.targets: string[]`
 *
 * ## 为什么非要有这个脚本(而不是跑一遍 typecheck)
 *
 * 这次改动动的是**签名覆盖的消息本身**。EIP-712 有一类特征:
 * **只要 domain 或类型定义有一处对不上,症状就是签名静默失效** ——
 * 服务端只说一句"签名与上传者地址不符",看不出是数组被动过。
 * 而 `shared/upload.ts` 里那段"绝不排序/去重/改写数组"的纪律,
 * **只有靠真的签一次、真的改一处、看它真的被拒**,才算被证明过。
 *
 * 所以这个脚本验的是**七条边界**,一条一条拿证据:
 *
 * ```
 * 【1】targets=['content','preview']  → content/ 拿得到 token      (正向)
 * 【2】targets=['content','preview']  → preview/ 拿得到 token      (正向)
 * 【2b】那张 token 的内容确实是预期的那一份(类型/上限/防覆盖)     (正向)
 * 【3】targets=['content']           → preview/ **必拒**           (安全)
 * 【4】数组顺序被换过                  → **必拒**(验签失败)          (安全)
 * 【5】targets=[] / ['bogus']         → **必拒**(形状)              (安全)
 * 【6】content-meta: targets 不含 content → **必拒**               (安全)
 * 【7】targets=['preview'] 单store    → preview/ 拿到、content/ 必拒 (补图)
 * 【8】GET /api/previews 的形状(键必须小写)                      (补图)
 * ```
 *
 * 【3】是这次改动**唯一可能引入的新攻击面**:一条"传内容"的授权,
 * 现在要是能顺带写公开 store,付费内容就会被写进人人可读的 CDN。
 * 【4】是这条纪律的反面:服务端要是"顺手把数组排个序",一个能被
 * 正常验过的签名就会变成验不过 —— 或者更糟,两个不同的授权算出同一个摘要。
 *
 * ## 【7】【8】是 2026-09-25 加的:「补预览图」那条路
 *
 * 内容看板上补预览图走的是一条**只授权 `preview` 一个 store** 的签名
 * (见 `hooks/usePreviewBackfill.ts`)。它与【1】【2】方向相反,所以必须
 * **各自验一遍**:正向证明那条路真的能走通,反向证明它的**爆炸半径**是零
 * —— 补图要是能写 `content/`,就等于用一个"改缩略图"的入口去重写付费内容本身。
 *
 * 【8】验的是看板据以判断"这一件缺不缺缩略图"的那个端点。它最容易错的地方
 * 是**键的大小写**:看板按小写 contentId 查表,而 `0xABC…` 与 `0xabc…`
 * 在 JSON 里是两个不同的键 —— 一旦哪天不归一化了,症状是看板给**每一件**
 * 内容都显示"补预览图",而任何一件点下去都会失败(那张图早就传过了)。
 *
 * ## ⚠️ 它花什么、不花什么
 *
 * **不花一分钱、不上链、不写任何 blob。** 它只打"要 token"那一枪,
 * 而那一步在服务端只做校验和签发 —— 没有任何字节被上传。
 *
 * 唯一的副作用:`api/upload.ts` 的 ⑥ 会为这个 contentId 写一条
 * **归属 KV**(先到先得)。用的是**每次运行随机生成**的 contentId,
 * 所以留下的是一个孤儿键,不指向任何真实内容。介意的话可以删。
 *
 * 用法:
 *   # 另开一个窗口:vercel dev --listen 3000
 *   node scripts/verify-upload-targets.mjs [--base http://localhost:3000]
 *
 * 退出码:0 = 全过;1 = 有失败。
 */

import { randomBytes } from 'node:crypto'
import { getAddress, recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

/* ─────────────────── 契约常量(与 shared/ 保持同步) ─────────────────── */
/**
 * ⚠️ 下面这几行是**副本**,不是引用 —— `scripts/` 在两个 tsconfig 的 include
 * 之外,**不能** import `shared/*.ts`(与 `verify-unlock.mjs` 顶部那条同一个理由)。
 * 改了 `shared/upload.ts` 或 `shared/eip712.ts` 记得同步这里,
 * 否则症状是"签名永远验不过" —— 而看不出是副本过期了。
 */
const SPLITTER = '0xDe9b3090263e20ebD5b3795F0199B500f6da72f5' // shared/chain.ts DEPLOYED_SPLITTER
const CHAIN_ID = 43113 // shared/chain.ts CHAIN.id (Avalanche Fuji)
const DOMAIN_NAME = 'SplitJar' // shared/eip712.ts SPLITJAR_DOMAIN_NAME
const DOMAIN_VERSION = '1' // shared/eip712.ts SPLITJAR_DOMAIN_VERSION

/** shared/upload.ts UPLOAD_TYPES —— ⚠️ 字段顺序是签名的一部分,别重排 */
const UPLOAD_TYPES = {
  Upload: [
    { name: 'contentId', type: 'bytes32' },
    { name: 'targets', type: 'string[]' },
    { name: 'uploader', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
}

const DOMAIN = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: SPLITTER,
}

/* ─────────────────── 断言小工具 ─────────────────── */

let passed = 0
let failed = 0
const failures = []

function ok(label, detail) {
  passed++
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label, detail) {
  failed++
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}
/** 一个只打印不判定的信息行 */
function info(msg) {
  console.log(`    · ${msg}`)
}
function section(title) {
  console.log(`\n${title}`)
}

/* ─────────────────── 打接口 ─────────────────── */

/**
 * 复刻 `@vercel/blob/client` 要 token 时那个请求体。
 *
 * ⚠️ 形状来自 SDK 的 `handleUpload`(`dist/client.js` 里那个 switch):
 * `body.payload` 只读 `pathname` / `clientPayload` / `multipart` 三样,
 * `callbackUrl` 由它自己算(而我们从没设过 `onUploadCompleted`)。
 * 所以这里不带 `callbackUrl` 是对的。
 */
async function requestToken(base, { pathname, wire }) {
  const send = async () => {
    const res = await fetch(`${base}/api/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'blob.generate-client-token',
        payload: { pathname, clientPayload: JSON.stringify(wire), multipart: false },
      }),
    })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      // 非 JSON 的响应体(比如 SPA 回退给的 index.html)—— 留原文,别丢证据
    }
    return { status: res.status, body, text }
  }

  /**
   * ⚠️ 只对 `upstream_unavailable` 重试,而且**次数有限**。
   *
   * 起因是 2026-09-25 实测到的一件事:本机走代理访问 Upstash 时,
   * **冷连接会被 RESET** —— 同一个请求(同一个 contentId、同一个 NX SET)
   * 第 1 次成功、第 2 次 `fetch failed / ECONNRESET`、第 3 次又成功。
   * 把两个 store 的请求**换个顺序**,失败就跟着"第二个"跑而不是跟着
   * 某个 store 跑 —— 这就证明了它与被验的边界无关,是本地网络的事。
   *
   * 但**不能**因此把 503 当通过:服务端真的连不上 KV 时也是这个码,
   * 而那是一个必须暴露的问题。所以重试之后仍然 503 就照原样报失败 ——
   * 重试只吃掉抖动,吃不掉故障。
   */
  const attempts = 3
  let last
  for (let i = 0; i < attempts; i++) {
    last = await send()
    if (last.body?.error?.code !== 'upstream_unavailable') return last
    if (i < attempts - 1) {
      info(`第 ${i + 1} 次拿到 upstream_unavailable,重试(本地冷连接抖动,见脚本内注释)`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  return last
}

/**
 * 拆开 SDK 那张 clientToken,看服务端**到底授权了什么**。
 *
 * 形状照抄 `dist/client.js` 的 `getPayloadFromClientToken`:
 * 用 `_` 切,取第 5 段,base64 → JWT 的 payload 段 → JSON。
 *
 * 为什么要拆:【2b】要验的不是"拿到了一个字符串",而是
 * **"这个 token 被限死在公开 store、只许 image/*、且不许覆盖"** ——
 * 那才是"受限 token"这句话的实体。拿到个字符串说明不了任何事。
 */
function decodeClientToken(clientToken) {
  const parts = clientToken.split('_')
  const encoded = parts[4]
  if (!encoded) return null
  const jwt = Buffer.from(encoded, 'base64').toString()
  const payloadB64 = jwt.split('.')[1]
  if (!payloadB64) return null
  return JSON.parse(Buffer.from(payloadB64, 'base64').toString())
}

/* ─────────────────── 组一条已签名的授权 ─────────────────── */

function makeWire(account, contentId, targets, deadlineSeconds = 300) {
  const message = {
    contentId,
    targets,
    uploader: getAddress(account.address),
    deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds),
  }
  return account
    .signTypedData({
      domain: DOMAIN,
      types: UPLOAD_TYPES,
      primaryType: 'Upload',
      message,
    })
    .then((signature) => ({
      // ⚠️ 逐字段手摆,顺序与 `UploadAuthWire` 一致 —— 这一层是 JSON,
      // 字段顺序不影响验签,但保持一致便于和线上抓包对照
      wire: {
        contentId,
        targets,
        uploader: message.uploader,
        deadline: message.deadline.toString(),
        signature,
      },
      message,
    }))
}

/* ─────────────────── 主流程 ─────────────────── */

const argv = process.argv.slice(2)
const baseArg = argv.indexOf('--base')
const BASE_URL = (baseArg >= 0 ? argv[baseArg + 1] : null) ?? process.env.BASE_URL ?? 'http://localhost:3000'

console.log('verify-upload-targets —— Upload.targets[] 安全回归')
console.log(`  目标:${BASE_URL}`)

// 前置:服务得活着。先打一发健康检查,免得后面所有失败都长得像"签名不对"
{
  let health
  try {
    health = await fetch(`${BASE_URL}/api/health`)
  } catch (e) {
    console.error(`\n✗ 连不上 ${BASE_URL} —— 先另开一个窗口跑 \`vercel dev --listen 3000\``)
    console.error(`  ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
  if (!health.ok) {
    console.error(`\n✗ /api/health 回了 HTTP ${health.status} —— 服务没起来`)
    process.exit(1)
  }
  info(`/api/health → ${health.status}`)
}

/**
 * ⚠️ **每次运行现生成一把临时私钥**,不用任何真实钱包。
 *
 * 理由有两条:① 这次验的是"服务端认不认这个签名形状",与"谁签的"无关
 * (上传这条路的授权只看签名 + 归属先到先得,不看链上余额);
 * ② 真实的创作者私钥**绝不能**为了跑一个测试而进到一个脚本里。
 */
const account = privateKeyToAccount(generatePrivateKey())
info(`临时签名地址(每次运行都不同): ${account.address}`)

/** 全程只用这一个 contentId —— 于是 ⑥ 最多留一条孤儿 KV 键 */
const contentId = `0x${randomBytes(32).toString('hex')}`
info(`临时 contentId: ${contentId}`)

// ── 前置自检:这个脚本自己签出来的东西,能不能被自己验回来 ─────────────
//
// ⚠️ 这一条是**给脚本自己用的**。要是这里就不过,那说明副本的类型定义
// 已经和 `shared/upload.ts` 分叉了 —— 后面所有"必拒"都会通过(拒的原因
// 是签名不对,而不是我们在验的那条边界),整份报告就成了假绿。
{
  section('【0】前置自检:副本的类型定义能不能验回自己')
  const { wire, message } = await makeWire(account, contentId, ['content', 'preview'])
  const recovered = await recoverTypedDataAddress({
    domain: DOMAIN,
    types: UPLOAD_TYPES,
    primaryType: 'Upload',
    message,
    signature: wire.signature,
  })
  if (recovered.toLowerCase() === account.address.toLowerCase()) {
    ok('这一份 Upload 类型定义能自洽地签/验', '说明副本没和 shared/upload.ts 分叉')
  } else {
    bad('副本自检都没过', `${recovered} != ${account.address} —— 先同步 shared/upload.ts 的类型定义`)
    console.log('\n报告不可信,后续步骤不再有意义。')
    process.exit(1)
  }
}

// ── 【1】【2】正向:一次签名覆盖两个 store ────────────────────────────
{
  section('【1】正向:targets=[content, preview] → 写 content/ 拿到 token')
  const { wire } = await makeWire(account, contentId, ['content', 'preview'])
  const res = await requestToken(BASE_URL, { pathname: `content/${contentId}`, wire })

  if (res.status === 200 && typeof res.body?.clientToken === 'string') {
    ok('content/ 的 token 签发成功', `HTTP 200,clientToken 长度 ${res.body.clientToken.length}`)

    // 顺带把"私有 store 那份 token 长什么样"记下来 —— 与【2b】对照
    const tok = decodeClientToken(res.body.clientToken)
    if (tok) {
      info(`content token 载荷: allowOverwrite=${tok.allowOverwrite} maximumSizeInBytes=${tok.maximumSizeInBytes} allowedContentTypes=${JSON.stringify(tok.allowedContentTypes)}`)
    }
  } else {
    bad('content/ 的 token 没签发出来', `HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
}

{
  section('【2】正向:targets=[content, preview] → 写 preview/ 拿到 token')
  const { wire } = await makeWire(account, contentId, ['content', 'preview'])
  const res = await requestToken(BASE_URL, { pathname: `preview/${contentId}`, wire })

  if (res.status === 200 && typeof res.body?.clientToken === 'string') {
    ok('preview/ 的 token 签发成功 —— 一次签名覆盖了两个 store', 'HTTP 200')

    section('【2b】那张 token 是不是"受限"的(公开 store / 只收图 / 不许覆盖)')
    const tok = decodeClientToken(res.body.clientToken)
    if (!tok) {
      bad('拆不开 clientToken', '形状变了?见 client.js 的 getPayloadFromClientToken')
    } else {
      info(`allowOverwrite=${tok.allowOverwrite}`)
      info(`maximumSizeInBytes=${tok.maximumSizeInBytes}`)
      info(`allowedContentTypes=${JSON.stringify(tok.allowedContentTypes)}`)
      info(`pathname=${tok.pathname}`)

      // `shared/storage.ts` 里两份的取值,这里只断言"方向对"而不抄数字 ——
      // 抄数字就是第二个定义处,上限改了这里会假红
      if (tok.allowOverwrite === false) ok('allowOverwrite 是 false')
      else bad('allowOverwrite 不为 false', `拿到的是 ${tok.allowOverwrite}`)

      if (Array.isArray(tok.allowedContentTypes) && tok.allowedContentTypes.includes('image/*')) {
        ok('预览图那条只收 image/*')
      } else {
        bad('预览图那条的类型限制不对', JSON.stringify(tok.allowedContentTypes))
      }

      if (tok.pathname === `preview/${contentId}`) ok('token 钉死在这一条 pathname 上')
      else bad('token 的 pathname 不是我们请求的那条', String(tok.pathname))
    }
  } else {
    bad('preview/ 的 token 没签发出来', `HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
}

// ── 【3】安全:只授权了 content,就不能写 preview ─────────────────────
{
  section('【3】安全:targets=[content] → 写 preview/ 必须被拒')
  const { wire } = await makeWire(account, contentId, ['content'])
  const res = await requestToken(BASE_URL, { pathname: `preview/${contentId}`, wire })

  if (res.status === 200) {
    bad('一条"传内容"的授权写进了公开 store', '付费内容会被放上人人可读的 CDN')
  } else if (res.body?.error?.message?.includes('不在授权范围内')) {
    ok('被拒,且理由是"不在授权范围内"', `HTTP ${res.status} ${res.body.error.code}`)
  } else {
    // 被拒了,但理由不对 —— 比如"签名不符"。那意味着拦它的**不是**
    // `allowsUploadTarget`,而我们就会误以为这条边界有守卫
    bad('被拒了,但理由不是"不在授权范围内"', `HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
}

// ── 【4】安全:数组的顺序是签名的一部分,服务端不得改写 ────────────────
{
  section('【4】安全:把 targets 的顺序换一下 → 必须验签失败')
  const { wire } = await makeWire(account, contentId, ['content', 'preview'])
  // 只换顺序,元素一模一样。服务端要是"顺手排个序"或者逐元素比对时
  // 用了 Set,这条就会被**接受** —— 那等于签名管不住数组
  const tampered = { ...wire, targets: ['preview', 'content'] }
  const res = await requestToken(BASE_URL, { pathname: `content/${contentId}`, wire: tampered })

  if (res.status === 200) {
    bad('换过顺序的授权被接受了', '服务端在改写数组,或者没把数组算进摘要')
  } else if (res.body?.error?.code === 'bad_signature') {
    ok('被拒,且理由是签名不符', `HTTP ${res.status}`)
  } else {
    bad('被拒了,但理由不是 bad_signature', `HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
}

// ── 【5】畸形输入 ──────────────────────────────────────────────────
{
  section('【5】畸形的 targets 必须走形状拒(而不是 500 / 静默通过)')

  for (const [label, targets] of [
    ['空数组 []', []],
    ['不认识的名字 ["bogus"]', ['bogus']],
    ['元素不是字符串 [1]', [1]],
  ]) {
    const { wire } = await makeWire(account, contentId, ['content'])
    const res = await requestToken(BASE_URL, {
      pathname: `content/${contentId}`,
      wire: { ...wire, targets },
    })
    if (res.status === 400 && res.body?.error?.code === 'bad_request') {
      ok(`${label} → 400 bad_request`, '形状拒,不是崩')
    } else {
      bad(`${label} 没被形状拒`, `HTTP ${res.status} ${res.text.slice(0, 200)}`)
    }
  }
}

// ── 【6】content-meta 的"必须含 content"这一条 ────────────────────────
//
// ⚠️ 这条端点在**验完形状之后、碰链之前**就判这一句,所以不需要
// 一个真实存在的内容 —— 而下面那个"含 content"的正向对照会走到链上,
// 对一个随机 id 回 404。**那个 404 就是"闸门放行了"的证据**。
{
  section('【6】content-meta:授权里必须含 content')

  const post = async (body) => {
    const res = await fetch(`${BASE_URL}/api/content-meta`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* 留原文 */
    }
    return { status: res.status, body: parsed, text }
  }

  // 负向:只授权了 preview → 拒
  {
    const { wire } = await makeWire(account, contentId, ['preview'])
    const res = await post({ ...wire, title: '不该被写进去的标题' })
    if (res.status === 400 && res.body?.error?.message?.includes('不是用于内容本身')) {
      ok('targets=[preview] → 400,理由是"不是用于内容本身的"')
    } else {
      bad('targets=[preview] 没被挡住', `HTTP ${res.status} ${res.text.slice(0, 200)}`)
    }
  }

  // 正向对照:含 content → 放行(会在链上查不到 → 404)
  {
    const { wire } = await makeWire(account, contentId, ['content', 'preview'])
    const res = await post({ ...wire, title: '对照用的标题' })
    if (res.status === 404 && res.body?.error?.code === 'content_not_found') {
      ok(
        '含 content 的授权放行了这一句 → 之后倒在"链上查不到"',
        '这条 404 证明闸门放行、而不是被 content 那一句挡住',
      )
    } else {
      bad(
        '含 content 的授权没走到链上那一步',
        `HTTP ${res.status} ${res.text.slice(0, 200)} —— 期待 404 content_not_found`,
      )
    }
  }
}

// ── 【7】补预览图那条路:只授权 preview 一个 store ────────────────────
//
// 看板的「补预览图」签的就是这个形状(`targets: ['preview']`)。
// 正向与反向都要验:正向证明那条路能走通,反向证明它的**爆炸半径是零**。
{
  section('【7】补预览图:targets=[preview] 的单 store 授权')

  // 正向:这条授权确实能写 preview/
  {
    const { wire } = await makeWire(account, contentId, ['preview'])
    const res = await requestToken(BASE_URL, { pathname: `preview/${contentId}`, wire })

    if (res.status === 200 && typeof res.body?.clientToken === 'string') {
      ok('preview/ 的 token 签发成功 —— 补预览图那条路走得通', 'HTTP 200')

      const tok = decodeClientToken(res.body.clientToken)
      if (!tok) bad('拆不开 clientToken', '形状变了?见 client.js 的 getPayloadFromClientToken')
      else if (tok.pathname === `preview/${contentId}` && tok.allowOverwrite === false) {
        ok('它仍然钉死在 preview/<contentId> 上,且不许覆盖')
      } else {
        bad('那张 token 的约束不对', `pathname=${tok.pathname} allowOverwrite=${tok.allowOverwrite}`)
      }
    } else {
      bad('preview/ 的 token 没签发出来', `HTTP ${res.status} ${res.text.slice(0, 300)}`)
    }
  }

  // 反向:**同一个**授权不能写 content/
  //
  // ⚠️ 这一条是补图这条路的安全边界。它要是不成立,一个"改缩略图"的入口
  // 就成了**重写付费内容本身**的入口 —— 而私有 store 里那份正是买家花过钱的东西。
  {
    const { wire } = await makeWire(account, contentId, ['preview'])
    const res = await requestToken(BASE_URL, { pathname: `content/${contentId}`, wire })

    if (res.status === 200) {
      bad('一条"补预览图"的授权写进了私有 store', '补图的爆炸半径不是零')
    } else if (res.body?.error?.message?.includes('不在授权范围内')) {
      ok('写 content/ 被拒,理由是"不在授权范围内"', `HTTP ${res.status} ${res.body.error.code}`)
    } else {
      bad('被拒了,但理由不是"不在授权范围内"', `HTTP ${res.status} ${res.text.slice(0, 300)}`)
    }
  }
}

// ── 【8】看板据以判断的端点:GET /api/previews ────────────────────────
//
// ⚠️ 这里**不假设** store 里有几张图(本地/线上都可能一张都没有),
// 所以只验形状。但形状里有**一条是要紧的**:键必须是小写的 contentId
// —— 看板按小写查表,不归一化就会"每一件都显示缺缩略图"。
{
  section('【8】GET /api/previews 的形状')

  let res
  try {
    res = await fetch(`${BASE_URL}/api/previews`)
  } catch (e) {
    bad('打不通 /api/previews', e instanceof Error ? e.message : String(e))
    res = null
  }

  if (res) {
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      /* 留原文 */
    }

    if (res.status === 503) {
      // 服务端没配公开 store → 它**必须**回 503 而不是空对象,
      // 否则看板分不出"没配"和"大家都没传"(见 api/previews.ts 文件头)
      info(`HTTP 503 ${body?.error?.code ?? ''} —— 这个环境没配公开 store,形状无法继续验`)
    } else if (res.status === 200 && body && typeof body.previews === 'object' && body.previews !== null) {
      const keys = Object.keys(body.previews)
      const allLower = keys.every((k) => /^0x[0-9a-f]{64}$/.test(k))
      const allUrls = keys.every((k) => typeof body.previews[k] === 'string' && body.previews[k].startsWith('http'))

      ok('HTTP 200,previews 是个对象', `现在有 ${keys.length} 张`)
      if (allLower) {
        ok('键全是小写 contentId', keys.length === 0 ? '(空表,这条是空真)' : `例:${keys[0].slice(0, 12)}…`)
      } else {
        bad('有键不是小写 contentId —— 看板会查不到', JSON.stringify(keys.slice(0, 3)))
      }
      if (allUrls) ok('值全是 http 开头的 URL')
      else bad('有值不是 URL', JSON.stringify(keys.slice(0, 3).map((k) => body.previews[k])))
    } else {
      bad('形状不对', `HTTP ${res.status} ${text.slice(0, 300)}`)
    }
  }
}

/* ─────────────────── 收尾 ─────────────────── */

console.log(`\n${'─'.repeat(60)}`)
if (failed === 0) {
  console.log(`✓ 全过(${passed} 项)。Upload.targets[] 的边界成立。`)
  process.exit(0)
}
console.log(`✗ ${failed} 项失败 / 共 ${passed + failed} 项:`)
for (const f of failures) console.log(`   - ${f}`)
process.exit(1)
