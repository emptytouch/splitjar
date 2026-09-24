#!/usr/bin/env node
/**
 * 第 7 条验收 —— **链上判,不靠截图**。
 *
 * spec §16.1 第 7 条要的是:看板上,agent 那笔付款标注为 "Agent"、且分账比例与人类一致。
 * 链上没有"买家类型"字段,所以判据是:
 *   ① 新创作者 0xAa05…0bba 名下、(苹果图)那件内容,有 ≥1 笔 agent 付款 + ≥1 笔人类付款;
 *   ② 两(多)笔的 recipients/amounts 完全一致 —— 即"分账比例与人类一致";
 *   ③ agent 那笔的 payer 在 shared/agentAddresses.json 白名单里(看板 [Agent] 徽章就靠它)。
 *
 * 跑法(本机出网只走本地代理 127.0.0.1:7897):
 *   export HTTPS_PROXY=http://127.0.0.1:7897
 *   node --use-env-proxy scripts/check-7th.mjs
 *
 * 出处:地址/常量抄自 scripts/agent-buy.mjs 与 shared/chain.ts,每条标了来源。
 */
import { createPublicClient, http, parseAbiItem, getAddress, formatUnits } from 'viem'
import { avalancheFuji } from 'viem/chains'
import { readFileSync } from 'node:fs'

// ── 常量(出处见注释,抄写有漂移风险,故标来源) ──────────────────────────
const SPLITTER = '0xDe9b3090263e20ebD5b3795F0199B500f6da72f5' // shared/chain.ts DEPLOYED_SPLITTER
const DEPLOY_BLOCK = 58_513_443n // shared/chain.ts DEPLOY_BLOCK —— getLogs 起点
const RPC = process.env.AGENT_RPC ?? 'https://api.avax-test.network/ext/bc/C/rpc' // shared/chain.ts DEFAULT_RPC_PRIMARY
const USDC_DEC = 6 // shared/chain.ts USDC.decimals

// 第 7 条的两个角色(出处:agent-buy.mjs KNOWN_OTHER_ROLES,已在链上核过 checksum)
const NEW_CREATOR = getAddress('0xAa05f6809B1f358e53f2c1D65A75eD6b7aAd0bba')
const HUMAN_BUYER = getAddress('0x737a8a9E051a3a43a26c45Fb5511f768acB0ebae')

// 白名单 —— 与前端 shared/agentAddresses.ts、agent-buy.mjs 读的是同一份
const WHITELIST = JSON.parse(
  readFileSync(new URL('../shared/agentAddresses.json', import.meta.url), 'utf8'),
).agents.map((a) => getAddress(a.address))
const isAgent = (a) => WHITELIST.includes(getAddress(a))

// PaymentSplit(bytes32 indexed contentId, address indexed payer, address[] recipients, uint256[] amounts)
const PAYMENT_SPLIT_EVENT = parseAbiItem(
  'event PaymentSplit(bytes32 indexed contentId, address indexed payer, address[] recipients, uint256[] amounts)',
)
const GET_CONTENT = parseAbiItem(
  'function getContent(bytes32 contentId) view returns (address creator, uint256 price, bytes32 contentHash, address[] recipients, uint16[] splits, bool active)',
)

// ── 客户端 ──────────────────────────────────────────────────
const client = createPublicClient({ chain: avalancheFuji, transport: http(RPC) })

// 主备都受 50k 上限(commit 77ade90),分窗扫
const CHUNK = 50_000n
const latest = await client.getBlockNumber()
const logs = []
for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK) {
  const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n
  const part = await client.getLogs({
    address: SPLITTER,
    event: PAYMENT_SPLIT_EVENT,
    fromBlock: from,
    toBlock: to,
  })
  for (const l of part) logs.push(l)
  process.stderr.write(`  扫 ${from} → ${to}: +${part.length} (累计 ${logs.length})\n`)
}

process.stderr.write(`\nPaymentSplit 事件共 ${logs.length} 笔\n\n`)

// ── 按 contentId 分组 ──────────────────────────────────────
const byContent = new Map()
for (const l of logs) {
  const id = l.args.contentId
  if (!byContent.has(id)) byContent.set(id, [])
  byContent.get(id).push(l)
}

let allPass = true
let found7th = false

for (const [id, evs] of byContent) {
  // viem 多返回值是位置元组,无具名属性(见 agent-buy.mjs 注释)——按顺序解构
  const content = await client.readContract({
    address: SPLITTER,
    abi: [GET_CONTENT],
    functionName: 'getContent',
    args: [id],
  })
  const [creatorR, priceR, , recipientsR, splitsR, activeR] = content
  const creator = getAddress(creatorR)
  const agentEvs = evs.filter((e) => isAgent(e.args.payer))
  const humanEvs = evs.filter((e) => !isAgent(e.args.payer))
  // 分账签名:把 recipients+amounts 拼成字符串比较
  const sigs = evs.map((e) =>
    e.args.recipients.map((r, i) => `${getAddress(r)}:${e.args.amounts[i].toString()}`).join('|'),
  )
  const sameSplit = sigs.every((s) => s === sigs[0])

  const is7th = creator === NEW_CREATOR && agentEvs.length >= 1 && humanEvs.length >= 1
  if (is7th) found7th = true

  const tag = is7th ? '  ← 第 7 条那件' : ''
  console.log(`内容 ${id}${tag}`)
  console.log(`  创作者 ${creator}${creator === NEW_CREATOR ? ' (新创作者)' : ''}`)
  console.log(`  价格 ${formatUnits(priceR, USDC_DEC)} USDC · active=${activeR}`)
  console.log(`  收款方 ${recipientsR.map((r) => getAddress(r)).join(', ')}`)
  console.log(`  分账比 ${splitsR.map((s) => `${s}/65535`).join(' : ')}`)
  console.log(`  付款 ${evs.length} 笔:`)
  for (const e of evs) {
    const ag = isAgent(e.args.payer) ? ' [Agent]' : ''
    const parts = e.args.recipients
      .map((r, i) => `${getAddress(r)}=${formatUnits(e.args.amounts[i], USDC_DEC)}`)
      .join(', ')
    console.log(
      `    #${e.blockNumber} payer ${getAddress(e.args.payer)}${ag}  → ${parts}`,
    )
  }

  if (is7th) {
    const both = humanEvs.length >= 1 && agentEvs.length >= 1
    const ok = both && sameSplit
    console.log(`  → 第 7 条: 人类+agent 并排 ${both ? '✓' : '✗'} · 分账一致 ${sameSplit ? '✓' : '✗'} · agent 在白名单 ${agentEvs.every((e) => isAgent(e.args.payer)) ? '✓' : '✗'}`)
    if (!ok) allPass = false
  }
  console.log('')
}

console.log('─'.repeat(60))
if (found7th && allPass) {
  console.log('✅ 第 7 条成立(链上判):新创作者 0xAa05…0bba 名下,人类 + agent 至少各一笔,')
  console.log('   分账 recipients/amounts 完全一致,agent 的 payer 在白名单。')
} else if (!found7th) {
  console.log('✗ 没找到"新创作者名下、人类+agent 各≥1 笔"的内容 —— 第 7 条验不了。')
  allPass = false
} else {
  console.log('✗ 第 7 条不成立(见上)。')
}
process.exit(allPass ? 0 : 1)
