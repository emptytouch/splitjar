#!/usr/bin/env node
/**
 * 把 `CreatorSplitter` 的 ABI 导出成**带类型的前端模块**。
 *
 * ```bash
 * cd contracts
 * node script/export-abi.mjs          # 覆盖写 ../shared/abi/creatorSplitter.ts
 * ```
 *
 * ## 为什么要脚本,而不是 README 里写一行 `forge inspect > …`
 *
 * 因为导出目标**不是** `forge inspect` 的原始输出。
 *
 * `forge inspect --json` 吐的是 JSON;而 `resolveJsonModule` 导进来的 JSON
 * 类型是**被放宽过的** —— `type: "function"` 被推成 `string` 而不是字面量。
 * viem 因此无法反推函数签名,后果是:
 *   - 读:`content.data` 退化成 `{}`,`content.data.price` 直接编译不过(TS2339)
 *   - 写:`writeContract({ args })` **完全不受检查**
 *
 * 第二条在付款应用里是要花真钱的 —— 参数写错编译器不会拦。
 *
 * 所以导出物必须是 `.ts` + `as const`,让字面量类型活下来。
 *
 * (试过 `[...json] as const`:TS1355 不报了,但字面量并没有真的恢复,
 *  viem 依然推不出来。只能从生成端解决。)
 *
 * ## 为什么不用 TS 的 `as const` 包一层就好
 *
 * TS1355 明确禁止对 import 绑定用 `as const`("can only be applied to
 * references to enum members, or string/number/boolean/array/object literals")。
 * 所以字面量必须在**源代码文本**里就是字面量。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(here, '../../shared/abi/creatorSplitter.ts')

const HEADER = `/**
 * CreatorSplitter 的 ABI —— **自动生成,请勿手改**。
 *
 * 重新生成:
 * \`\`\`bash
 * cd contracts && node script/export-abi.mjs
 * \`\`\`
 *
 * 来源:\`contracts/src/CreatorSplitter.sol\`(方案 §8.1 冻结的接口)
 *
 * ⚠️ 为什么是 .ts 而不是 .json —— 见 \`contracts/script/export-abi.mjs\` 的文件头。
 * 简单说:JSON 导入会把 \`type: "function"\` 放宽成 \`string\`,viem 就推不出签名,
 * 于是**写的参数不受任何检查**。付款应用不能接受这个。
 */
export const creatorSplitterAbi = `

let raw
try {
  raw = execFileSync('forge', ['inspect', 'CreatorSplitter', 'abi', '--json'], {
    cwd: resolve(here, '..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
} catch (err) {
  console.error('forge inspect 失败 —— 先在 contracts/ 下跑通 `forge build`:')
  console.error(err.stderr?.toString?.() || err.message)
  process.exit(1)
}

let abi
try {
  abi = JSON.parse(raw)
} catch {
  console.error('forge inspect 的输出不是 JSON。')
  console.error('⚠️ Foundry 1.7.1 默认打印**带边框的人读表格**,必须带 `--json`。')
  process.exit(1)
}

if (!Array.isArray(abi) || abi.length === 0) {
  console.error('ABI 是空的 —— 合约名拼错了,或者 forge build 没跑过。')
  process.exit(1)
}

// 缩进到 2 空格,再整体右移 2 格好让它在 `export const … = ` 下面好看
const body = JSON.stringify(abi, null, 2)
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')
  .trimStart()

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${HEADER}${body} as const\n`)

// ⚠️ 用 Map 而不是 `{}`:ABI 里有一项的 `type` 正好是 `"constructor"`,
// 而 `{}["constructor"]` 取到的是 `Object.prototype.constructor`(一个函数),
// 不是 undefined —— 于是计数变成 `Object() { [native code] }1`。
// 原型链污染这类坑,用 Map 一次断掉。
const counts = new Map()
for (const item of abi) {
  counts.set(item.type, (counts.get(item.type) || 0) + 1)
}

console.log(`已写入 ${outPath}`)
console.log(
  '  共',
  abi.length,
  '项 ——',
  [...counts]
    .map(([k, v]) => `${k} ${v}`)
    .join(' · '),
)
