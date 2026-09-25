/**
 * 从**内容文件本身**派生预览图 —— 创作者的浏览器里跑,不经过服务器。
 *
 * ## 为什么要"派生",而不是让创作者上传一张
 *
 * 方案 §13 的预览图是**公开 CDN 上的图**。如果由创作者自己传,就多出两个问题:
 * ① 他可以传一张和内容毫无关系的图(买家点进去发现买的是别的东西);
 * ② 更要紧的,他可以**传原图** —— 那张图一旦在公开 CDN 上,付费内容
 *    就等于白送。派生这条路的输入是内容文件,输出是我们自己压过、
 *    打过水印的一张缩略图,**创作者没有机会把原图放上公开路径**。
 *
 * ⚠️ 但要说清楚它的边界:派生只保证"这张图是从那份文件生成的",
 * 不保证"这张图好看"或"能代表内容"。一个 PDF 的第一页可能只有封面标题。
 * 这是可接受的 —— 预览图是索引,不是内容。
 *
 * ## 派生不出来的类型怎么办(2026-09-25 决策)
 *
 * PDF、压缩包、音频等**派生不出**。这一版的选择是**允许无预览图发布**,
 * 而不是拦住发布:
 *
 * - 预览图只是 catalog 里的一张索引图,内容本身照样可买、可下载、可验指纹;
 * - 拦住的代价是真实的("我这个 PDF 就是想卖,凭什么不让我发"),
 *   而收益只是"网格里那一格好看一点"。
 *
 * 所以 `unavailable` 是一条**正常出路**,不是错误 —— 界面要如实说明
 * "这件内容在广场上没有预览图",而不是把它显示成一次失败。
 *
 * ## ⚠️ 一处如实记下的内存边界
 *
 * 图片走 `createImageBitmap(file)`,**它会按原分辨率解码**。
 * 一张一亿像素的图(约 400 MB RGBA)在手机上会直接抛 —— 那种情况
 * 会被下面的 `catch` 收成 `decode-failed`,也就是"发布成功但没有预览图",
 * 而不是一次崩溃或一次发布失败。演示素材的量级(几千像素)完全没问题。
 */

/**
 * 预览图最长边的像素数。
 *
 * 1200 是"网格里看得清、点开也不糊"的量级。再大只是让公开 CDN 上的
 * 流量白涨 —— 它不是内容,是索引图。
 */
export const PREVIEW_MAX_EDGE = 1200

/** 编码质量。0.82 是 webp 在"看不出块"和"体积够小"之间的常见折中 */
const PREVIEW_QUALITY = 0.82

/**
 * 预览图的编码格式。
 *
 * ⚠️ 浏览器**可以**忽略这个参数:不支持 webp 编码时会静默回落成 PNG
 * (`toBlob` 的规范行为)。这是可接受的 —— PNG 照样满足
 * `ALLOWED_CONTENT_TYPES.preview` 的 `image/*`,而 1200px 的 PNG
 * 离 `MAX_UPLOAD_BYTES.preview` 的 8 MiB 还很远。
 * **别**因为"体积更小"就在下面加一句"必须是 webp 否则报错"。
 */
export const PREVIEW_MIME = 'image/webp'

/** 水印上的字。抽成常量,免得徽标文案和代码各说一套 */
const WATERMARK_TEXT = 'SplitJar 预览'

/** 等 `<video>` 加载元数据/跳帧的上限。视频坏了不该让"选文件"卡住 */
const VIDEO_READY_TIMEOUT_MS = 8000
const VIDEO_SEEK_TIMEOUT_MS = 4000

/**
 * 派生结果。
 *
 * ⚠️ 这是一个**和 `Draft` 同时有效**的东西,理由与 `Draft` 把 `file`/`hash`
 * 绑在一起完全相同:预览图必须和它所来自的那个文件对得上。松开这个绑定
 * 就会出现"哈希是新的、预览图还是上一份文件的" —— 而那种错从界面上看不出来。
 */
export type PreviewDerivation =
  | {
      k: 'derived'
      /** 压过、打过水印的那张图。发布时原样传进公开 store */
      blob: Blob
      width: number
      height: number
      /** 从静态图来,还是从视频抽的一帧。只用于文案 */
      from: 'image' | 'video-frame'
    }
  | { k: 'unavailable'; reason: PreviewUnavailableReason }

export type PreviewUnavailableReason =
  /** 本来就不是图/视频(PDF、压缩包、音频…)。**这是正常的,不是错误** */
  | 'unsupported-type'
  /** 声称是图/视频,但浏览器解不开(格式太怪、文件损坏、图大到解不动) */
  | 'decode-failed'

/** 派生结果里那张图。`unavailable` 时为 `null` —— 发布流程据此决定传不传预览 */
export function previewBlobOf(d: PreviewDerivation): Blob | null {
  return d.k === 'derived' ? d.blob : null
}

/**
 * 这个类型的文件**按理说**能不能派生。
 *
 * ⚠️ 它只按 MIME 判,不代表一定能成 —— 一个扩展名是 `.png`、
 * 内容却是乱码的文件会返回 `true`,然后在 `derivePreview` 里得到
 * `decode-failed`。所以界面**不要**拿它当"一定会有预览图"的依据,
 * 它只用来决定要不要显示"正在生成预览…"这种等待态。
 */
export function canDerivePreview(file: File): boolean {
  const t = file.type.toLowerCase()
  return t.startsWith('image/') || t.startsWith('video/')
}

/**
 * 派生一张预览图。**永不抛异常** —— 失败走 `unavailable`。
 *
 * 理由同 `shared/storage.ts` 里那批解析函数:这条路上"失败"是一种
 * **正常的业务结果**(见文件头那段),让调用方用 try/catch 去接
 * 只会让每个调用点都得记得写一遍"失败了也能发"。
 */
export async function derivePreview(file: File): Promise<PreviewDerivation> {
  if (!canDerivePreview(file)) {
    return { k: 'unavailable', reason: 'unsupported-type' }
  }

  const type = file.type.toLowerCase()
  let bitmap: ImageBitmap
  let from: 'image' | 'video-frame'
  try {
    if (type.startsWith('video/')) {
      bitmap = await grabVideoFrame(file)
      from = 'video-frame'
    } else {
      // ⚠️ `createImageBitmap` 对 SVG 常常会失败(没有内联宽高时它无从确定
      // 画布尺寸)—— 那会落到下面的 `decode-failed`。SVG 本来也不该被
      // 当成"内容文件"传,这里不去专门伺候它
      bitmap = await createImageBitmap(file)
      from = 'image'
    }
  } catch {
    return { k: 'unavailable', reason: 'decode-failed' }
  }

  try {
    const encoded = await encodePreview(bitmap)
    return { k: 'derived', ...encoded, from }
  } catch {
    return { k: 'unavailable', reason: 'decode-failed' }
  } finally {
    // ⚠️ `ImageBitmap` 占的是**解码后的显存/内存**(一张 4000×3000 的图约 48 MB),
    // 不主动关掉就得等 GC —— 而用户在选文件之后马上还会传一个几百 MiB 的文件。
    // 这个 `finally` 是那条内存边界上唯一的一道闸
    bitmap.close()
  }
}

/** 压到 `PREVIEW_MAX_EDGE` 以内、画上水印、编码成一张图 */
async function encodePreview(
  bitmap: ImageBitmap,
): Promise<{ blob: Blob; width: number; height: number }> {
  // ⚠️ 按**长边**算缩放,且只在需要缩小时才缩(`Math.min(1, …)`)——
  // 一张本来就比 1200 小的图被放大只会变糊
  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  // 理论上不可能——除非有人把 canvas 的 2d 上下文配额耗光了
  if (!ctx) throw new Error('previewDerive: 拿不到 2d 上下文')

  ctx.drawImage(bitmap, 0, 0, width, height)
  drawWatermark(ctx, width, height)

  return { blob: await canvasToBlob(canvas), width, height }
}

/**
 * 打水印 —— **强制,没有开关**。
 *
 * ## 为什么非打不可
 *
 * 预览图在**公开 CDN** 上,任何人拿到直链就能存下来。它就是靠"打了水印
 * 所以不能直接当成品用"来和付费内容拉开距离的。一张干净的原图放在
 * 公开路径上,等于这件内容已经在白送了。
 *
 * ## 为什么是**平铺**的,不是一个角标
 *
 * 角标可以被裁掉 —— 裁掉之后那张图就完全等同于原图了。所以铺满整张,
 * 让任何一块裁下来的区域上都还留着字。
 *
 * ⚠️ 浓度是**刻意压得低**的(0.12 上下):这张图同时还是广场网格里的
 * 缩略图,水印重到看不清是什么东西,预览图就白做了。这个平衡点是
 * "能认出内容 + 抹不掉标记",不是"看不清内容"。
 * 改了浓度请回到 `/explore` 上按真实缩略图尺寸看一眼再定。
 */
function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const size = Math.max(11, Math.round(Math.min(w, h) / 20))

  ctx.save()
  ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 斜 30° 平铺。步长按图的大小走,小图上不会挤成一团
  const stepX = Math.round(Math.max(150, size * 9))
  const stepY = Math.round(Math.max(90, size * 5))

  // 先绕画布中心转,铺完再转回来 —— 直接按旋转后的坐标系算铺满范围很难写对,
  // 多画几行比"精确算出边界"便宜得多
  ctx.translate(w / 2, h / 2)
  ctx.rotate(-Math.PI / 6)
  ctx.translate(-w / 2, -h / 2)

  // 铺的范围要盖住旋转之后的整个画布:旋转不会让内容超出原画布的对角范围
  const reach = Math.ceil(Math.hypot(w, h))
  const originX = Math.round((w - reach) / 2)
  const originY = Math.round((h - reach) / 2)

  ctx.lineWidth = Math.max(1.5, size / 9)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.13)'

  for (let y = originY; y < originY + reach; y += stepY) {
    for (let x = originX; x < originX + reach; x += stepX) {
      // 描边 + 填充:浅色底上靠描边看得见,深色底上靠填充看得见。
      // 只画一层的话,总有一半的素材会把水印吞掉
      ctx.strokeText(WATERMARK_TEXT, x, y)
      ctx.fillText(WATERMARK_TEXT, x, y)
    }
  }
  ctx.restore()
}

/** `toBlob` 的回调写成 Promise。`null` 是"编码失败",必须 reject 而不是当空图 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('previewDerive: 编码失败'))),
      PREVIEW_MIME,
      PREVIEW_QUALITY,
    )
  })
}

/**
 * 从视频里抽一帧。
 *
 * ## 为什么取 10% 处而不是第一帧
 *
 * 第一帧经常是黑场、台标或渐入 —— 抽出来的预览图是一团黑,比没有还糟。
 * 10% 处基本已经进入正片。上限 5 秒是为了别在一个很长的视频里跳到
 * 太靠后的位置(那可能是片尾字幕)。
 *
 * ## `muted` + `playsInline` 是必须的
 *
 * 不静音的话有些浏览器会因为"自动播放带声音的媒体"策略直接不给解码;
 * `playsInline` 是 iOS Safari 上不进入全屏播放器所必需的。这里其实
 * **不播放**,只是解码取帧,但那两条属性仍然决定它能不能顺利解码。
 */
async function grabVideoFrame(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'

  try {
    await waitForMediaEvent(video, 'loadeddata', VIDEO_READY_TIMEOUT_MS)

    const duration = video.duration
    const at = Number.isFinite(duration) && duration > 0 ? Math.min(duration * 0.1, 5) : 0
    if (at > 0) {
      video.currentTime = at
      // ⚠️ 有些容器/编码上 `seeked` 不会来(或者很慢)。等不到就用当前帧 ——
      // 一帧黑图也好过让"选文件"这一步永远转圈
      await waitForMediaEvent(video, 'seeked', VIDEO_SEEK_TIMEOUT_MS).catch(() => {})
    }

    return await createImageBitmap(video)
  } finally {
    // 不 revoke 的话这个 blob 会一直占着内存直到整页刷新 ——
    // 而它可能是一个几百 MiB 的视频
    URL.revokeObjectURL(url)
    // 断开对 blob 的引用,让浏览器能立刻释放解码器
    video.removeAttribute('src')
    video.load()
  }
}

/** 等一个媒体事件,带超时。超时和 `error` 都 reject */
function waitForMediaEvent(el: HTMLMediaElement, name: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener(name, onOk)
      el.removeEventListener('error', onErr)
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error(`previewDerive: 媒体事件 ${name} 前报错`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`previewDerive: 等 ${name} 超时`))
    }, timeoutMs)

    el.addEventListener(name, onOk)
    el.addEventListener('error', onErr)
  })
}

/**
 * 派生结果说成人话 —— 给发布页和看板用。
 *
 * ⚠️ `unsupported-type` 的措辞**不能像报错**。它是"这类文件没有预览图"
 * 这个事实本身,而且发布照常(见文件头)。写成"失败了"会让创作者以为
 * 自己哪里做错了,然后去找一张根本不需要的图。
 */
export function describePreview(d: PreviewDerivation): string {
  switch (d.k) {
    case 'derived':
      return d.from === 'video-frame'
        ? `已从视频里取了一帧做预览图(${d.width}×${d.height}),上面打了水印。`
        : `已生成预览图(${d.width}×${d.height}),上面打了水印。`
    case 'unavailable':
      return d.reason === 'unsupported-type'
        ? '这类文件生成不出预览图 —— 不影响发布,只是广场上这一件没有缩略图。'
        : '这个文件我们读不出画面,所以没有预览图 —— 不影响发布和购买。'
    default: {
      const never: never = d
      return never
    }
  }
}
