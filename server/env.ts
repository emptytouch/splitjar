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
 */
export const SERVER_ENV = [
  {
    name: 'BLOB_READ_WRITE_TOKEN',
    when: 'W6 · 私密内容存储(Vercel Blob,store 创建时选 private)',
    required: true,
  },
  {
    name: 'QUOTE_HMAC_SECRET',
    when: 'W7 · 签/验 402 报价,防篡改',
    required: true,
  },
  {
    name: 'SPLITTER_ADDRESS',
    when: 'W7 · 服务端读链校验付款(前端另有一份 VITE_ 的)',
    required: true,
  },
  {
    name: 'RPC_PRIMARY',
    when: 'W7 · 服务端读链主端点',
    required: true,
  },
  {
    name: 'RPC_BACKUP',
    when: 'W7 · 服务端读链备用端点',
    required: false,
  },
  {
    name: 'KV_REST_API_URL',
    when: 'W8 · 402 报价防重放',
    required: true,
  },
  {
    name: 'KV_REST_API_TOKEN',
    when: 'W8 · 402 报价防重放',
    required: true,
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
