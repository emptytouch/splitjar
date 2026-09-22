import { serverEnvReady, serverEnvStatus } from '../server/env.js'
import { CHAIN, USDC } from '../shared/chain.js'

/**
 * 部署健康探针 —— 唯一目的:证明「静态前端 + Serverless Function」这条链路是通的。
 *
 * ## 为什么 W1 就要有它
 *
 * 方案里依赖三样 Vercel 能力:Blob(private 存储)、KV(防重放)、Functions。
 * 三样都只是「已核实存在」,**但从没实测过组合**。等 W6 建 store、W8 接 KV 时
 * 才发现构建配置不对,离交稿就只剩几天了。现在铺一层空壳把链路先跑通,
 * 是把这个风险从 W8 提前到 W1。
 *
 * ## 边界
 *
 * - **不承载任何业务逻辑** —— 真正的路由在 W6/W7 才写
 * - **这个接口是公开的**(任何人不带凭证就能访问),所以写进响应体的东西
 *   都必须假设全世界看得到。密钥只报"在不在",绝不含值。
 *
 * ## 首次部署后必须验证两件事
 *
 * 1. `/api/health` 返回 JSON —— 而不是被 `vercel.json` 的 SPA rewrite 吃掉
 * 2. `/` 返回页面 —— 证明 rewrite 没把静态资源也一起吃掉
 *
 * 这两条对应 `vercel.json` 里那条负向先行断言的 rewrite 规则。**那条规则
 * 是按"两种优先级下都正确"的思路写的,但没有在真实部署上核实过。**
 *
 * ## ✅ 2026-09-23 首次部署实测:rewrite 是对的,但这个文件本身有两处错
 *
 * 顺序是"先被别的错挡住,修完才轮到下一个",两次都是**只有 runtime log 看得见**:
 *
 * 1. **`ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/server/env'`** ——
 *    `package.json` 是 `"type": "module"`,Vercel 就把每个 `.ts` 单独编译成 `.js`
 *    放上去、**不打包**,而 Node 的 ESM **要求相对导入带扩展名**。原来那种
 *    `from '../server/env'` 的写法在 ESM 下**永远解析不了**(ESM 不会去试 `.js`)。
 *    → 修法:`api/` `server/` `shared/` 里所有相对导入补 `.js`。
 *    ⚠️ 这条影响的是**四个路由全部**,不只是 health —— 它们都 import 了 `server/`。
 * 2. **default export 的返回值被丢掉**(下面那个 `GET` 的注释)——
 *    症状是请求**挂住不响应**,不是报错。
 *
 * 教训:**"构建成功 + 函数体积正常"完全不代表它能跑。** 首次部署必须真的打一次。
 */
/**
 * ⚠️ **必须是具名的 `GET` 导出,不能是 `export default`。**
 *
 * Vercel 的 Node 运行时把 default export 当作老的 `(req, res) => void` 签名 ——
 * 返回值**直接丢掉**。写成 `export default function () { return Response.json(…) }`
 * 的后果不是报错,是**请求永远等不到响应**:客户端一直转圈,最后超时。
 * 错误信息只在 runtime log 里出现一条 WARN,页面上什么都看不到。
 *
 * 具名导出 `export function GET(request) { return new Response(…) }` 才是
 * Web 签名那条路。(2026-09-23 首次部署时踩到。)
 */
export function GET(): Response {
  const env = serverEnvStatus()

  return Response.json({
    ok: true,
    service: 'splitjar',
    chain: { name: CHAIN.name, id: CHAIN.id },
    usdc: USDC.address,
    // 只报数量与名单,不含任何值 —— 见 server/env.ts
    serverEnv: {
      ready: serverEnvReady(),
      configured: env.filter((e) => e.configured).length,
      total: env.length,
      items: env,
    },
    at: new Date().toISOString(),
  })
}
