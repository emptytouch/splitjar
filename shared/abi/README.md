# shared/abi — 合约与前端之间的接口契约

这个目录**不手写**。文件由 Foundry 生成,生成物**提交入库**。

## 为什么要提交生成物

`contracts/out/` 是构建产物,已在 `.gitignore` 里,所以前端不能直接引用它。
而 ABI 是「合约 ↔ 前端 ↔ 服务端」三方的**接口契约** —— 它是源码级的事,
入库才有可追溯性(能看出某次前端改动对应的是哪一版 ABI)。它也很小。

## 怎么生成(每次改合约都要重跑)

```bash
cd contracts
forge build
forge inspect CreatorSplitter abi --json > ../shared/abi/creatorSplitter.json
```

> ⚠️ **`--json` 不能省。** Foundry 1.7.1 的 `forge inspect ... abi` 默认打印一张
> 人读的表格(带边框的那种),直接重定向会得到一个**不是 JSON 的文件**,
> 前端 import 时才炸,而且报错位置离原因很远。这一点是 2026-09-21 实际踩到的。

生成后**必须验一下是合法 JSON**,别只看命令没报错:

```bash
node -e "const a=require('./shared/abi/creatorSplitter.json'); console.log(a.length)"
```

## 怎么用

```ts
import creatorSplitterAbi from '../shared/abi/creatorSplitter.json'
```

> ⚠️ 前端走 Vite 的 `resolveJsonModule`,导入 JSON 需要**默认导入**语法;
> `shared/` 由两份 tsconfig 各检查一遍(前端带 DOM、服务端不带),这个文件
> 在两边都必须成立。

## 当前内容

`creatorSplitter.json` —— `CreatorSplitter` 的完整 ABI(30 项,2026-09-21 生成)。
写入接口严格等于产品方案 §8.1 的冻结清单,外加两个 view:

| 额外项 | 为什么必须有 |
|---|---|
| `getContent(bytes32)` | `Content` struct 里有动态数组,Solidity **不会**为 public mapping 生成可用的 getter。没有它前端读不到价格和分账比例。 |
| `contentExists(bytes32)` | 前端在渲染付费页前要先判断这件内容存不存在,不能靠 catch revert。 |

两个都是 view,**不改任何写入接口的语义**,因此不构成对冻结接口的破坏。
