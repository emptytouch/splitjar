import { serverEnvReady, serverEnvStatus } from '../server/env'
import { CHAIN, USDC } from '../shared/chain'

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
 */
export default function handler(): Response {
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
