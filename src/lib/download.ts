/**
 * 「把内容交到用户硬盘上」这件事的两个做法。
 *
 * ## 背景:为什么一个下载要写这么多(2026-09-23)
 *
 * 付费内容存在 Vercel 的**私有** Blob store 里,pathname 冻结成
 * `content/<contentId>`(见 `shared/storage.ts`)—— **没有扩展名**。
 * 而下载完成后浏览器拿到的文件名就是这条 pathname 的最后一段,
 * 于是本地存下来是一个叫 `0x6410fb09…` 的文件。
 *
 * 字节是**完全正确**的(2026-09-23 实测:本地文件 keccak256 与链上
 * `contentHash` 逐字节一致),但 Windows 没有扩展名就认不出类型 ——
 * 用户的原话是「本地无法打开」。**这不是"文件坏了",是"没名字"。**
 *
 * 试过的四条路,以及为什么只剩这一条:
 *
 * ① **`<a download>`** —— 被规范**明确忽略**,因为这条链路永远跨源
 *    (app 在 `splitjar.vercel.app`,blob 在 `*.private.blob.vercel-storage.com`)。
 *    那个属性只在同源 / `blob:` / `data:` 下生效。
 * ② **服务端 `presignUrl` 传 `contentDisposition`** —— **没有这个选项**。
 *    `PresignGetUrlOptions` 在 `@vercel/blob` 2.8.0 里只有
 *    `{ operation, pathname, validUntil, useCache }`。
 * ③ **上传时把扩展名写进 pathname** —— 要放宽 `PATHNAME_RE`,而那条正则
 *    正是防路径穿越、以及保证"一个 contentId 只对应一条 pathname"
 *    (从而让 `allowOverwrite` 的逐字节判重有效)的边界。扩展名来自客户端输入。
 *    而且只对**以后**的上传生效,已传的内容仍是旧路径。
 * ④ **让 `/api/unlock` 流回字节** —— 内容要穿过 Function,200 MiB 的素材
 *    够呛;而且方案 §20.4.5.1 已经否过一次。
 *
 * 于是走这条:**先把字节取回内存,再自己起个名字。**
 * 关键在于 `URL.createObjectURL()` 产出的是 **`blob:` 同源 URL** ——
 * 于是 `a.download` 就生效了(见 ①:它只在同源下有用)。
 * 名字、扩展名完全由我们定,而且不用动存储布局、不用重传。
 *
 * ## 代价,如实记下
 *
 * - **整个文件进内存**。与 §20.4.6(`computeFileHash` 把整个文件读进内存)
 *   是同一类边界。演示素材量级没问题,200 MiB 上限的手机端够呛。
 * - **需要 blob 域名允许跨源 `fetch`**。这条**本机验证不了** ——
 *   `*.private.blob.vercel-storage.com` 在这台机器上 `ECONNRESET`。
 *   所以 `downloadWithName` 返回 `false` 时,调用方**必须**回退到
 *   `navigateToDownload`(也就是修复前的老行为)。
 *   **最坏情况是维持现状,不会比现在更差。**
 */

/**
 * MIME → 扩展名。
 *
 * 覆盖"演示素材"这一档(PDF / 图 / 视频 / 音频 / 压缩包 / 文本)。
 * 查不到就退到 `extFromSubtype`,再不行就**不给扩展名** ——
 * 宁可不给,也不要瞎猜一个错的(猜错比没有更糟:系统会用错的程序去开)。
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/epub+zip': 'epub',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

/** 只接受这种形状的串当扩展名 —— 别的一律不要 */
const SAFE_EXT_RE = /^[a-z0-9]{1,5}$/

/**
 * 从 MIME 的子类型里捞一个扩展名,当作 `EXT_BY_MIME` 没命中时的第二手。
 *
 * 处理三件事:`x-` 前缀(`application/x-7z-compressed`)、结构化后缀
 * (`+xml` / `+json`),以及**子类型里合法但不像扩展名**的东西。
 * 捞不到就返回空串 —— 见 `EXT_BY_MIME` 上那段"宁可不给"。
 */
export function extFromSubtype(mime: string): string {
  const sub = mime.split('/')[1]?.trim().toLowerCase()
  if (!sub) return ''
  const base = sub.replace(/\+.*$/, '').replace(/^x-/, '')
  return SAFE_EXT_RE.test(base) ? base : ''
}

/**
 * 从 MIME 猜扩展名(不含点)。猜不到返回空串。
 *
 * ⚠️ **只认参数里那个 `type`,不看任何别的东西。** 参数是 blob 响应头
 * `Content-Type` 来的(`res.blob().type` 就是这个值),而 `Content-Type`
 * 在 CORS 里是**安全列表响应头**,所以跨源也读得到,不需要
 * `Access-Control-Expose-Headers`。这一点是这条修法能成立的前提。
 */
export function extFromMime(mime: string): string {
  const t = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXT_BY_MIME[t] ?? extFromSubtype(t)
}

/**
 * 从**头几个字节**猜文件类型 —— MIME 什么都没给出时的最后一道。
 *
 * 什么情况下会走到这儿:上传时 `file.type` 是空串,于是
 * `src/lib/uploadApi.ts` 兜底成了 `application/octet-stream`
 * (见那里的 `contentType`)。那种 blob 的 `Content-Type` 毫无信息量,
 * 而**症状和用户报的这个一模一样**(有文件、打不开)。
 *
 * 只认几个魔数,够用就行 —— 这是一道保险,不是文件类型识别器。
 */
export function extFromBytes(head: Uint8Array): string {
  const at = (i: number) => head[i]
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'gif'
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return 'pdf'
  if (at(0) === 0x50 && at(1) === 0x4b) return 'zip' // 也是 docx/xlsx 的容器,zip 更好过没有
  if (at(0) === 0x1f && at(1) === 0x8b) return 'gz'
  // RIFF....WEBP
  if (head.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
      && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp'
  // ....ftyp
  if (head.length >= 12 && at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) return 'mp4'
  return ''
}

/** 文件名主体最长留多少 —— 别让一个标题把路径顶爆 */
const MAX_BASE = 80

/**
 * 把任意字符串洗成一个**能当文件名**的串。
 *
 * ⚠️ 这个函数的输入是**客户端可控的**:标题来自分享链接的 `?t=` 参数
 * (见 `PayPage`),任何拿到链接的人都能改。而它会变成**买家硬盘上的文件名**。
 * 所以这里是边界,不是装饰:
 *
 * - 去掉路径分隔符 `/ \` 与 Windows 非法字符 `: * ? " < > |`
 * - 去掉控制字符(0x00–0x1F、0x7F)
 * - 去掉**开头**的点(`..` / 隐藏文件)与**结尾**的点和空格
 *   (Windows 存不下以点或空格结尾的名字,不处理会静默失败)
 * - 折叠空白、限长(按**码点**截,免得把一个字切成半个代理对)
 * - 撞上 Windows 设备名(`con`/`nul`/`com1`…)就加个下划线前缀
 * - 洗完是空的就用 `fallback`
 *
 * 浏览器自己也会挡一部分,但**不能靠它** —— 这是我们的输入,我们的责任。
 */
export function safeFilename(raw: string, fallback: string): string {
  const kept = Array.from(raw)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0
      if (c < 0x20 || c === 0x7f) return false
      return !'/\\:*?"<>|'.includes(ch)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

  const trimmed = Array.from(kept).slice(0, MAX_BASE).join('')
  // 截断可能重新制造出"结尾是点或空格"、"开头是点",所以再修一次
  const cleaned = trimmed.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')

  if (!cleaned) return fallback
  // Windows 保留设备名。只在**完整匹配**时加前缀,别误伤 "console" 这类
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`
  return cleaned
}

/**
 * 老路子:**把 URL 直接交给浏览器**。
 *
 * ⚠️ 这里**故意没有 `a.download`**,不要加回来 —— 跨源下它被忽略,
 * 后果不是"文件名不对",是**根本不下载**(浏览器按普通导航处理,
 * 把文件内联打开,用户得自己"另存为")。
 * "下载还是打开"由服务端决定:`/api/unlock` 返回的 URL 已过
 * `getDownloadUrl()`,响应带 `Content-Disposition: attachment`。
 *
 * `target="_blank"` **保留**,这是刻意的失败方向选择:最坏是多开一个
 * 标签页(用户关掉就行);去掉它最坏是当前页面被导航走、整个应用状态丢失。
 */
export function navigateToDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** `blob:` URL 交出去后多久回收。见 `downloadWithName` 里的注释 */
const REVOKE_AFTER_MS = 60_000

/**
 * 取回字节、自己起名、交给浏览器。**成功返回 `true`。**
 *
 * 返回 `false` 时调用方**必须**回退到 `navigateToDownload` ——
 * 可能的失败原因是跨源 `fetch` 被 CORS 拦、链接过期(403)、网络断了。
 * 这几种情况下老路子仍是可用的(至少在链接没过期时),所以回退有意义。
 *
 * ⚠️ **必须查 `res.ok`。** 不过期/没权限时 blob 主机返回的是 403 加一段
 * 错误体,`res.blob()` 会照单全收 —— 不查的话用户会存下一个**叫 `.png`
 * 的错误页**,比没有扩展名更糟(它会用一个正经图片程序去开,然后报错)。
 */
export async function downloadWithName(url: string, baseName: string): Promise<boolean> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    // CORS 被拦 / 断网。这里**不区分**两者:对调用方来说都是"这条走不通,回退"
    return false
  }
  if (!res.ok) return false

  let blob: Blob
  try {
    blob = await res.blob()
  } catch {
    return false
  }
  if (blob.size === 0) return false

  // 先信 Content-Type;它没给出有用的东西时,再看头几个字节
  let ext = extFromMime(blob.type)
  if (!ext) {
    try {
      ext = extFromBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))
    } catch {
      // 切片读不出来就算了,大不了没有扩展名
    }
  }

  const name = safeFilename(baseName, 'content') + (ext ? `.${ext}` : '')
  const objectUrl = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = objectUrl
  // ⚠️ 这一行是整条修法的**全部要害**:`blob:` 是同源的,所以 `download` 生效。
  // 换成那条跨源的签名 URL,这行就是死代码(见文件头 ①)。
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()

  // ⚠️ **别立刻 revoke。** 下载是异步的,`click()` 返回时浏览器**还没读完**
  // 那个 blob;当场回收会让大文件下载中途断掉(小文件碰巧能成,所以这个 bug
  // 会表现为"小图好的、大视频坏的")。给足时间再回收。
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_AFTER_MS)

  return true
}
