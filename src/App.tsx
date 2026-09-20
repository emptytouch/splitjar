import { useAccount } from 'wagmi'
import { Balances } from './components/Balances'
import { ChainProbe } from './components/ChainProbe'
import { AppShell, Card, PageHeader, Placeholder } from './components/Shell'
import { CHAIN } from '../shared/chain'

/** W1 的完成定义,直接长在页面上 —— 打开就知道还差哪一步(开发计划 W1) */
function Checklist() {
  const { isConnected, chainId } = useAccount()
  const onFuji = isConnected && chainId === CHAIN.id

  const items: Array<[boolean, string]> = [
    [true, '页面构建通过'],
    [isConnected, '连上钱包'],
    [onFuji, `在 ${CHAIN.name} 上`],
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {items.map(([done, label]) => (
        <span key={label} className="flex items-center gap-2 text-xs">
          <span className={done ? 'text-emerald-400' : 'text-muted'}>{done ? '✓' : '○'}</span>
          <span className={done ? 'text-neutral-300' : 'text-muted'}>{label}</span>
        </span>
      ))}
      <span className="ml-auto text-[11px] text-muted">W1 完成定义 · 开发计划</span>
    </div>
  )
}

export default function App() {
  return (
    <AppShell>
      <PageHeader
        title="创作者控制台"
        subtitle={
          <>
            定好价格和分账比例,上传内容,拿到一个付费页。买家付稳定币,钱按比例
            <span className="text-neutral-300">直达</span>各方钱包 —— 无平台抽成,无资金池。
          </>
        }
        badge={
          <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-full border border-line bg-surface px-3.5 py-1.5 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {CHAIN.name} · chainId {CHAIN.id}
          </span>
        }
      />

      <div className="space-y-5">
        <Card title="账户" hint="演示账户的状态,以及自动读取的 Fuji 链上参数">
          <Balances />
        </Card>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card
            title="链上探针"
            hint="用钱包实付口径结算一笔分账的 gas,它决定演示定价"
            className="lg:col-span-2"
          >
            <ChainProbe />
          </Card>

          <Card title="Agent 接入" hint="机器支付路径">
            <Placeholder note="W7 起 —— /api/catalog + HTTP 402 报价" />
          </Card>
        </div>

        <Card title="你的内容" hint="创建、定价、分账比例、上下架">
          <Placeholder note="W3 起 —— 创建付费内容 + 生成付费页与二维码" />
        </Card>
      </div>

      <div className="mt-5 rounded-2xl border border-line-soft bg-surface/40 px-5 py-4">
        <Checklist />
      </div>
    </AppShell>
  )
}
