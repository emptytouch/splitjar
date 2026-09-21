# shared/abi — 合约与前端之间的接口契约

这个目录**不手写**。文件由脚本从 Foundry 的产物生成,**生成物提交入库**。

## 为什么要提交生成物

`contracts/out/` 是构建产物,已在 `.gitignore` 里,所以前端不能直接引用它。
而 ABI 是「合约 ↔ 前端 ↔ 服务端」三方的**接口契约** —— 它是源码级的事,
入库才有可追溯性(能看出某次前端改动对应的是哪一版 ABI)。它也很小。

## 怎么生成(每次改合约都要重跑)

```bash
cd contracts
forge build
node script/export-abi.mjs
```

脚本内部就是 `forge inspect CreatorSplitter abi --json`,再包一层类型导出。

> ⚠️ **`--json` 不能省。** Foundry 1.7.1 的 `forge inspect ... abi` 默认打印一张
> 人读的表格(带边框的那种),直接重定向会得到一个**不是 JSON 的文件**,
> 前端 import 时才炸,而且报错位置离原因很远。这一点是 2026-09-21 实际踩到的。
> 脚本里对这种情况有显式检查,并会打印出这条原因。

## ⚠️ 为什么导出的是 `.ts` 而不是 `.json`(2026-09-22 改)

原本导出 `creatorSplitter.json`。**那个做法有个查不出来的坑。**

`resolveJsonModule` 导进来的 JSON,类型是**被放宽过的** —— `type: "function"`
被推成 `string` 而不是字面量 `"function"`。viem 因此无法反推函数签名,后果是:

| 后果 | 表现 |
|---|---|
| 读退化 | `content.data` 变成 `{}`,`content.data.price` 直接编译报错(TS2339) |
| **写的参数完全不受检查** | `encodeFunctionData({ functionName:'createContent', args:[…] })` 里参数类型写错、函数名拼错,**编译器一句话都不说** |

第二条在**付款应用**里是要花真钱的。所以改成导出 `.ts` + `as const`,
让字面量类型活下来。

**试过但不管用的做法**:`[...json] as const` —— TS1355 不再报错,看起来像修好了,
但字面量并没有真的恢复,viem 依然推不出来。**只能从生成端解决**。
(TS1355 本身也禁止对 import 绑定直接 `as const`:只允许用于字面量。)

改完之后的实测效果:

```ts
// ① 参数类型错
encodeFunctionData({ abi, functionName:'createContent', args:['0x00','not-a-number','0x00',[],[]] })
//   TS2322: Type 'string' is not assignable to type 'bigint'.

// ② 函数名拼错
encodeFunctionData({ abi, functionName:'payy', args:[] })
//   TS2820: Type '"payy"' is not assignable to '"contentExists" | "createContent" | …'
//           Did you mean '"pay"'?
```

## 怎么用

```ts
import { creatorSplitterAbi } from '../shared/abi/creatorSplitter'
```

> ⚠️ `shared/` 由两份 tsconfig 各检查一遍(前端带 DOM、服务端不带),
> 这个文件在两边都必须成立。

> ⚠️ **`getContent` 返回的是元组(按位置),不是命名字段的对象。**
> viem 对多返回值的函数就是这么解的,所以 `content.data.price` 编译不过。
> 用 `src/lib/splitter.ts` 的 `toContent()` 转换 —— 位置访问**只在那一个地方**。

## 当前内容

`creatorSplitter.ts` —— `CreatorSplitter` 的完整 ABI(30 项,2026-09-21 生成,
2026-09-22 改为 TS 导出)。写入接口严格等于产品方案 §8.1 的冻结清单,外加两个 view:

| 额外项 | 为什么必须有 |
|---|---|
| `getContent(bytes32)` | `Content` struct 里有动态数组,Solidity **不会**为 public mapping 生成可用的 getter。没有它前端读不到价格和分账比例。 |
| `contentExists(bytes32)` | 前端在渲染付费页前要先判断这件内容存不存在,不能靠 catch revert。 |

两个都是 view,**不改任何写入接口的语义**,因此不构成对冻结接口的破坏。

`creatorSplitter.json` 已于 2026-09-22 删除 —— 它成了没人读的第二份产物,
留着只会和 `.ts` 漂移。
