import { Link } from 'react-router-dom'
import { Card, PageHeader } from '../components/Shell'
import { AgentAccess } from '../components/AgentAccess'
import { CHAIN } from '../../shared/chain'

/**
 * `/` —— 落地页(方案 2:角色分流)。
 *
 * 产品 demo 要让访客一眼走完「创作者发布 → 买家付费 → Agent 自助」整条链路,
 * 所以首屏不再是纯创作者后台,而是按角色分流:
 * - 我是创作者 → `/console`(控制台),主操作是发布内容(`/create`)、管理收款(`/dashboard`)
 * - 我是买家 → `/explore`(内容广场),逛+买
 * - 我是 Agent 开发者 → 本页内联机器接入说明(终端脚本,不在网页里跑)
 *
 * 顺序暗合 README 的演示剧本:创作者发一件 → 人类扫码买 → Agent 跑脚本自购 →
 * 创作者看板并排看到人类 + Agent 两笔。
 */
export function LandingPage() {
  return (
    <>
      <PageHeader
        title="SplitJar · 收钱罐"
        subtitle={
          <>
            创作者付费内容 + 链上多方分账。
            <b className="font-medium text-neutral-300">人类扫码付，AI Agent 走 HTTP 402 自助付</b>
            —— 钱按比例<span className="text-neutral-300">直达</span>
            各方钱包，无平台抽成，无资金池。
            <br />
            选你的角色开始：
          </>
        }
        badge={
          <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {CHAIN.name} · chainId {CHAIN.id}
          </span>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* 创作者 */}
        <Card title="我是创作者" hint="发布付费内容，设置分账比例，查看收款">
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-neutral-300">
              定好价格和分账比例，上传内容，拿到一个付费页。买家付稳定币，钱按比例直达各方钱包。
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link
                to="/create"
                className="rounded-lg btn-primary px-3.5 py-2 text-xs font-medium transition-colors"
              >
                发布内容
              </Link>
              <Link
                to="/dashboard"
                className="rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent"
              >
                管理收款
              </Link>
            </div>
          </div>
        </Card>

        {/* 买家 */}
        <Card title="我是买家" hint="浏览付费内容，连钱包一键购买">
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-neutral-300">
              逛内容广场，找到想买的内容，扫码或连接钱包付款，内容立即解锁下载。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/explore"
                className="inline-block rounded-lg btn-primary px-3.5 py-2 text-xs font-medium transition-colors"
              >
                去内容广场
              </Link>
              <Link
                to="/purchased"
                className="inline-block rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent"
              >
                查看已购
              </Link>
            </div>
          </div>
        </Card>

        {/* Agent 开发者 */}
        <Card title="我是 Agent 开发者" hint="机器支付路径 · HTTP 402">
          <AgentAccess />
        </Card>
      </div>
    </>
  )
}
