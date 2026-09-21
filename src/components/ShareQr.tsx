import { QRCodeSVG } from 'qrcode.react'

/**
 * 分享二维码。
 *
 * ⚠️ **只在宽屏显示** —— 这个判断不在这里,在调用方。理由:
 * 手机打开付费页时它自己**就是**那个页面,再显示一个指向自己的二维码
 * 没有任何意义。二维码解决的是"桌面端怎么把页面递给手机"。
 *
 * 用 `QRCodeSVG` 而不是 `QRCodeCanvas`:SVG 是矢量的,在任何 DPR 下都清晰,
 * 而且演示时若是投屏/截图,canvas 那种会被放大成马赛克。体积上 SVG 也小。
 */
export function ShareQr({ url, caption }: { url: string; caption?: string }) {
  return (
    <div className="flex flex-col items-center gap-3">
      {/*
        白底是**必须的**:二维码规范要求深色模块 + 浅色背景,
        而这个站点是纯深色主题。直接把二维码渲染在 --color-ink 上,
        大部分手机会扫不出来(反相识别不是所有扫码器都支持)。
      */}
      <div className="rounded-xl bg-white p-3">
        <QRCodeSVG value={url} size={148} level="M" marginSize={0} />
      </div>
      {caption && <p className="max-w-[200px] text-center text-[11px] leading-relaxed text-muted">{caption}</p>}
    </div>
  )
}
