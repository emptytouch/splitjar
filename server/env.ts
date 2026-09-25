/**
 * 服务端环境变量 —— **唯一事实来源**。
 *
 * ## 为什么需要这个文件
 *
 * Vercel 上 `VITE_` 前缀的变量会被**内联进前端产物**(谁都能在 dist 里读出来)。
 * 方案 §6.2 写了「私钥仅存环境变量,绝不出现在前端产物或仓库」,但**在此之前,
 * 代码里没有任何东西阻止有人手滑把 `QUOTE_HMAC_SECRET` 写成
 * `VITE_QUOTE_HMAC_SECRET`** —— 而那一下就把签名密钥公开了。
 *
 * 这个文件把那条纪律从"靠人记得"变成"编译期就拦得住":
 * 想读服务端密钥,只能走 `serverEnv()`,而它只认下面登记过的名字。
 *
 * ⚠️ **本文件位于 `server/`,不在 `api/`** —— Vercel 的 `api/` 目录约定是
 * 每个文件变成一个路由。辅助代码放进去会被当成公开端点暴露出去。
 *
 * ⚠️ `server/` 与 `api/` 一起由 `tsconfig.api.json` 检查,那份配置**不带 DOM**
 * (见该文件),所以这里误用 `document` / `window` 会当场报错 —— 这正是拆两份
 * tsconfig 的主要理由。
 */

/**
 * 登记表。`when` 只是给人看的排期提示,不参与逻辑。
 *
 * 新增服务端变量时**必须**加进这里,否则 `serverEnv()` 拿不到它。
 *
 * ⚠️ `when` 列 2026-09-23(W5 期间)整体校正过一次 —— 原来 5 条写的排期**都偏晚**,
 * 会让人以为"W5 还用不到"。凡是 W5 就要用的,这里一律标 W5。
 */
export const SERVER_ENV = [
  {
    name: 'BLOB_READ_WRITE_TOKEN',
    when: 'W5 · 私有 store(内容)。写入凭证不进前端,由 handleUpload 签受限 token',
    required: true,
  },
  {
    /**
     * ⚠️ **双下划线是刻意的,不要"顺手改成" `PUBLIC_READ_WRITE_TOKEN`。**
     *
     * Vercel 注入 Blob 凭证时变量名是**固定**的(`BLOB_READ_WRITE_TOKEN`),
     * 所以接第二个 store 必然撞名 —— 只能连到 development 把真值抠出来,
     * 再用**我们自己起的名字**手工 add。这个名字就是当时起的,已经部署上去了。
     * 改名 = 线上那份失效,而且失效方式是`undefined`(静默,不报错)。
     */
    name: 'PUBLIC__READ_WRITE_TOKEN',
    when: 'W5 · 公开 store(预览图,CDN 直出)。名字见上方注释,别改',
    required: true,
  },
  {
    name: 'SPLITTER_ADDRESS',
    when: 'W5 · 服务端读链校验付款(前端另有一份 VITE_ 的)',
    required: true,
  },
  {
    name: 'RPC_PRIMARY',
    when: 'W5 · 服务端读链主端点',
    required: true,
  },
  {
    name: 'RPC_BACKUP',
    when: 'W5 · 服务端读链备用端点',
    required: false,
  },
  {
    /**
     * ⚠️ 名字**不用改**。库从 `@vercel/kv`(2024-12 废弃)换成 `@upstash/redis`,
     * 但 `Redis.fromEnv()` 对 `UPSTASH_REDIS_REST_*` 和 `KV_REST_API_*`
     * 两套名字都认 —— 换库是纯配置动作,不动代码。(2026-09-23 核实)
     */
    name: 'KV_REST_API_URL',
    when: 'W5 · nonce(本包)+ 限额(W6)+ 402 防重放(W7)共用',
    required: true,
  },
  {
    name: 'KV_REST_API_TOKEN',
    when: 'W5 · 同上,与 KV_REST_API_URL 成对',
    required: true,
  },
  {
    name: 'QUOTE_HMAC_SECRET',
    when: 'W7 · 签/验 402 报价,防篡改',
    required: true,
  },
  {
    /**
     * ⚠️ **`required: false` 是刻意的,别"顺手"改成 true。**
     *
     * W14 包 A 的意图解析(`POST /api/parse-intent`)用它调 Anthropic。
     * 计划 §3.2 要求**没有它系统必须照常可用** —— 没配 key 时那条端点回
     * `{kind:'degraded'}`,界面退化成手动筛选框。
     * 一旦标成 `required`, `serverEnvReady()` 会变 false,等于在说
     * "没这个 key 就部署不起来" —— 而那与 §3.2 正好相反。
     *
     * 它也是本仓库**第一条会按次花钱**的服务端凭证:那条端点没有限流,
     * 前因后果见 `api/parse-intent.ts` 文件头。
     */
    name: 'ANTHROPIC_API_KEY',
    when: 'W14 · /explore 的一句话解析。⚠️ 可缺:缺了就降级成手动筛选',
    required: false,
  },
] as const

/** 登记过的服务端变量名。写成字面量联合,拼错名字编译期就报错。 */
export type ServerEnvName = (typeof SERVER_ENV)[number]['name']

/**
 * 读一个服务端密钥。
 *
 * 只接受登记过的名字 —— 这既防止拼错,也保证没有任何密钥能绕过 `SERVER_ENV`
 * 被读到(想读就得先登记,登记了就在 /api/health 里可见"配没配")。
 */
export function serverEnv(name: ServerEnvName): string | undefined {
  return process.env[name]
}

/**
 * 登记表的配置状态 —— **只报"在不在",绝不回显值**。
 *
 * `api/health.ts` 会把它整个公开出去,所以这里一个值都不能带。
 */
export function serverEnvStatus() {
  return SERVER_ENV.map((entry) => ({
    name: entry.name,
    when: entry.when,
    required: entry.required,
    configured: Boolean(process.env[entry.name]),
  }))
}

/** 必填项是否齐全 —— 部署后一眼看出还差什么 */
export function serverEnvReady(): boolean {
  return SERVER_ENV.filter((e) => e.required).every((e) => Boolean(process.env[e.name]))
}
