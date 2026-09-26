import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AGENT_ENTRIES } from '../../shared/agentAddresses'
import { shortAddress } from '../lib/links'

/** 一行可复制的命令 —— 只有它自己带「复制」,别的都是叙述 */
function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板 API 在非 HTTPS / 无权限时会 reject —— 命令就在上面,能手选
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="w-full rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-left font-mono text-[11px] text-neutral-300 transition-colors hover:border-accent"
      title="点一下复制"
    >
      <span className="text-muted">$ </span>
      {text}
      <span className="float-right text-muted">{copied ? '已复制' : '复制'}</span>
    </button>
  )
}

/**
 * 「Agent 接入」—— 方案 §14.1 那三个入口里的第三个(W8 补上,原先是个假占位)。
 *
 * ## ⚠️ 这张卡**故意没有一个「运行 agent」的按钮**
 *
 * 演示脚本要拿 agent 的**私钥**去签交易。而按方案 §6.2,私钥只存在于
 * **跑脚本那个 shell 的环境变量**里 —— 搬到这里就意味着把私钥放到
 * 服务端或浏览器上(决策 2:私钥不进服务端)。
 *
 * 所以这一格只**说清楚入口和命令**,真正的执行是人在自己终端里敲一行。
 * 这不是"没做完":agent 自主购买本来就不该由一个网页按钮代跑 ——
 * 那样跑起来的是网站,不是 agent。
 *
 * ## 四个动作,全走 HTTP
 *
 * 不需要登录、不需要钱包插件、不需要 SDK —— 一个能发 HTTP 请求的程序就能买。
 *
 * ⚠️ 2026-09-26(W14 包 A):上面那段是**终端脚本**那条路,广场上另有
 * 一条**完全不碰私钥**的路。两条路必须分开,否则用户会以为界面上那个
 * 输入框就是"agent 在买" —— 它不是。措辞按计划 §七.5:不许把它说成
 * agent、不许说它替你付款。
 *
 * 本组件原在 `ConsolePage`,方案 2(角色分流 landing)把它抽到这里,
 * 供首页 Landing 的「我是 Agent 开发者」栏复用。
 */
export function AgentAccess() {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-neutral-300">
        机器买家看目录、被拦下、按报价付款、取内容 —— 全程 HTTP,不需要登录,也不需要钱包插件。
      </p>

      <ol className="space-y-1.5 text-[11px] leading-relaxed text-muted">
        <li>
          <span className="font-mono text-neutral-300">GET /api/catalog</span> —— 看有什么可买
        </li>
        <li>
          <span className="font-mono text-neutral-300">GET /api/content/:id</span> —— 不带凭证,得{' '}
          <span className="font-mono text-amber-300/90">402</span> 和一份报价
        </li>
        <li>
          <span className="font-mono text-neutral-300">CreatorSplitter.pay(contentId)</span> ——
          链上付款,钱按比例直达各方
        </li>
        <li>
          <span className="font-mono text-neutral-300">GET /api/content/:id</span> +{' '}
          <span className="font-mono text-neutral-300">X-Payment</span> —— 得{' '}
          <span className="font-mono text-emerald-400">200</span> 与一条短时效直链
        </li>
      </ol>

      <div className="space-y-2 pt-1">
        <p className="text-[11px] text-muted">
          演示脚本(在自己的终端跑,<span className="text-neutral-300">私钥只在那个 shell 里</span>):
        </p>
        <Cmd text="export AGENT_PRIVATE_KEY=0x…" />
        <Cmd text="node scripts/agent-buy.mjs --dry-run" />
        <p className="text-[11px] leading-relaxed text-muted">
          <span className="font-mono">--dry-run</span> 停在付款那一刻之前 ——
          前四步一分钱不花,可以反复跑。去掉它才真的花钱。
        </p>
      </div>

      <p className="border-t border-line-soft pt-3 text-[11px] leading-relaxed text-muted">
        界面上另有一条<span className="text-neutral-300">不碰私钥</span>的入口:
        <Link to="/explore" className="mx-1 text-accent-soft hover:underline">
          内容广场
        </Link>
        可以用一句话说想找什么,由模型翻译成筛选条件。
        ⚠️ 那只是一次<b className="font-medium text-neutral-300">意图解析</b> ——
        <b className="font-medium text-neutral-300">不替你付款</b>
        ,买还是你自己点进去签。「授权 agent 替你扫货」还没做。
      </p>

      <p className="border-t border-line-soft pt-3 text-[11px] leading-relaxed text-muted">
        {AGENT_ENTRIES.length > 0 ? (
          <>
            看板上的 [Agent] 徽章<b className="font-medium text-neutral-300">按地址白名单判定</b>,
            不是自动识别。名单在{' '}
            <span className="font-mono text-neutral-300">shared/agentAddresses.json</span>
            {':'}
            {AGENT_ENTRIES.map((e) => (
              <span key={e.address} className="ml-1 font-mono text-neutral-300">
                {shortAddress(e.address)}
              </span>
            ))}
          </>
        ) : (
          <>
            看板上的 [Agent] 徽章<b className="font-medium text-neutral-300">按地址白名单判定</b>,
            不是自动识别 —— 名单(
            <span className="font-mono text-neutral-300">shared/agentAddresses.json</span>
            )现在是空的,所以还没有任何地址会被标成 Agent。
          </>
        )}
      </p>
    </div>
  )
}
