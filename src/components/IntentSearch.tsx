import { useIntentSearch, type Turn } from '../hooks/useIntentSearch'
import { ContentCard } from './ContentCard'
import type { CatalogEntry } from '../../shared/agentPay'
import type { DegradeReason } from '../../shared/intent'

/**
 * `/explore` 顶部的搜索区 —— 一句话找内容(W14 包 A)。
 *
 * ## ⚠️ 这一块**不是 agent**
 *
 * 它做的是**一次意图解析**:把你说的那句话翻译成"关键词 / 价格区间 / 最多几件"。
 * 不决定买什么、不碰私钥、不发起交易 —— **买还是你自己点进去买**。
 * 「授权后由 agent 替你扫货」是包 B(W15),**还没开工**。
 * 这句话必须写在界面上,不能只在文档里(计划 §3.2 / §七.5:文案不许夸大)。
 *
 * ## ⚠️ 2026-09-26:问答**排成记录**,但**不做成对话气泡**
 *
 * 计划 §3.3 第 1 条写的是「输入 + 消息流 + 结果区」。这里落的是记录流,
 * 但**故意不用气泡**:
 *
 * - 气泡的视觉约定是"两个人在说话",而这里**没有第二个人** —— 模型只做一次
 *   翻译就退场,没有第二轮、没有记忆。画成气泡就是在暗示有个 agent 在陪聊,
 *   那正是 §3.2 明令不许的("不要写成我实现了一个 agent")。
 * - 所以每行左侧是一个**陈述事实的标签**(`你` / `解析` / `没能解析` / `没能问上`),
 *   不是说话人名字。`解析` 是一个动作,不是一个人。
 * - ⚠️ 计划 §3.1 那张示意图上框里写着 `agent` —— **那张图和 §3.2 自相矛盾**,
 *   按 §3.2 走。已记在 `docs/W14-实施计划.md` §9.3。
 *
 * ## ⭐ 降级是"同一块面板换个人填",不是另一套 UI
 *
 * 模型不可用时,下面那几个筛选项**照样在那儿**,只是不再自动填 —— 用户自己填。
 * 所以"降级"这件事在界面上几乎看不出差别(计划 §3.2 要求:模型挂了,
 * 搜索仍然可用;不许白屏)。
 *
 * ## ⚠️ 结果区**回显筛条件**,这是筛错了唯一的可见信号
 *
 * 「找到 2 件 · 关键词「图」· ≤ 0.5 USDC」—— 用户能对着这句话检查
 * "它是不是把我说的话理解歪了"。没有这一行,一次误解的结果就是"少了几件",
 * 而那看起来像一个完全正常的结果。
 */
export function IntentSearch({ items }: { items: readonly CatalogEntry[] }) {
  const s = useIntentSearch(items)

  return (
    <>
      {/* ⚠️ 服务端说了"没配模型密钥" ⇒ 整个问句框收掉(见 useIntentSearch 文件头)。
          留着一个只可能再失败一次的按钮,比没有按钮更糟 —— 实测过。 */}
      {!s.parseUnavailable && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void s.ask()
          }}
          className="mb-3 flex flex-col gap-2.5 sm:flex-row"
        >
          <input
            aria-label="想找什么"
            value={s.text}
            onChange={(e) => s.setText(e.target.value)}
            // ⚠️ 与服务端 `MAX_QUERY_LENGTH` 同一个数(从 shared 引过来)。
            // 超长服务端会 400,但**别让用户敲到那里才发现** —— 输入框直接拦
            maxLength={s.maxQueryLength}
            placeholder="想找什么?例如「0.5 以下的图」"
            className={INPUT}
          />
          <button
            type="submit"
            disabled={s.asking || s.text.trim() === ''}
            className="shrink-0 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            {s.asking ? '正在理解…' : '问一问'}
          </button>
        </form>
      )}

      {!s.manual && (
        <p className="mb-5 text-[11px] leading-relaxed text-muted/70">
          一次意图解析:把你说的话翻译成筛选条件(由模型完成),不是自主决策 ——
          筛出来之后还是你自己点进去买。
        </p>
      )}

      {/* 问答记录。⚠️ 是"记录"不是"对话",见文件头那段 */}
      {s.turns.length > 0 && (
        <ol aria-label="解析记录" className="mb-5 space-y-3">
          {s.turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} onRetry={() => void s.ask(turn.question)} onManual={s.useManual} />
          ))}
        </ol>
      )}

      {/* 筛选项 —— 意图模式下由模型填,手动模式下用户自己填(见文件头) */}
      {(s.manual || s.asked) && (
        <div className="mb-5 rounded-2xl border border-line bg-surface/50 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="关键词(匹配标题)">
              <input
                aria-label="关键词"
                value={s.fields.keyword}
                onChange={(e) => s.setField('keyword', e.target.value)}
                placeholder="图"
                className={INPUT}
              />
            </Field>
            <Field label="最低价(USDC)">
              <input
                aria-label="最低价"
                value={s.fields.min}
                onChange={(e) => s.setField('min', e.target.value)}
                inputMode="decimal"
                placeholder="不限"
                className={INPUT}
              />
            </Field>
            <Field label="最高价(USDC)">
              <input
                aria-label="最高价"
                value={s.fields.max}
                onChange={(e) => s.setField('max', e.target.value)}
                inputMode="decimal"
                placeholder="0.5"
                className={INPUT}
              />
            </Field>
            <Field label="最多几件">
              <input
                aria-label="最多几件"
                value={s.fields.limit}
                onChange={(e) => s.setField('limit', e.target.value)}
                inputMode="numeric"
                placeholder="不限"
                className={INPUT}
              />
            </Field>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] leading-relaxed text-muted/70">
              {s.manual ? '手动筛选 —— 模型不可用时这些框照样能用。' : '上面是模型的理解,可以直接改。'}
            </p>
            <button
              type="button"
              onClick={s.clear}
              className="shrink-0 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-xs text-neutral-200 transition-colors hover:border-accent"
            >
              清掉筛选
            </button>
          </div>
        </div>
      )}

      {/* 价格框填坏了 —— 与"筛完为空"必须分开显示(见 useIntentSearch 文件头) */}
      {s.active && s.priceError !== null && (
        <div className="mb-5 rounded-2xl border border-accent/35 bg-accent/[0.07] px-5 py-4">
          <p className="text-sm text-neutral-100">价格填得不对:{s.priceError}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            这一项没法用来筛,所以现在没有在筛 —— 改一下上面的框,或者清掉筛选看全部。
          </p>
        </div>
      )}

      {s.active && s.summary !== null && s.results !== null && (
        <p aria-live="polite" className="mb-4 text-xs leading-relaxed text-muted">
          {/* ⚠️ `emptyFilter` 必须**排在** `results.length > 0` 前面。
              这两条会同时成立(空条件 + 目录非空 ⇒ 结果就是全部)。
              反过来写的话,用户说「看看有什么」会看到「找到 2 件」——
              那个数字和广场上的总数一模一样,说它只是噪音(2026-09-26 被
              `probe-intent-search.mjs` 的场景 1b 抓出来过)。 */}
          {s.emptyFilter ? (
            <>没有提取到具体条件 —— 下面是全部 {items.length} 件在售内容</>
          ) : s.results.length > 0 ? (
            <>
              找到 <span className="text-neutral-200 tnum">{s.results.length}</span> 件 · {s.summary}
            </>
          ) : (
            // ⚠️ 这个分支只在"有筛条件且筛完为空"时进来。另外两种"没有"分别由
            // 上面那一支和 `ExplorePage` 的链上 0 件负责(方案 §14.2)
            <>{s.summary} 下一件都没有 —— 广场上现在共有 {items.length} 件在售。</>
          )}
        </p>
      )}

      {s.results !== null ? (
        s.results.length > 0 ? (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {s.results.map((item) => (
              <ContentCard key={item.contentId} item={item} />
            ))}
          </ul>
        ) : (
          // 走到这儿必然是"有筛条件且筛完为空" —— 空条件时结果等于全部,
          // 而 `items.length > 0` 才轮得到本组件渲染(见上面那段)。
          // 筛到空与"链上没有内容"是两件事,文案必须不同(方案 §14.2)
          <div className="rounded-2xl border border-dashed border-line px-5 py-14 text-center">
            <p className="text-sm text-neutral-300">没有符合条件的在售内容</p>
            <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
              条件收窄一点试试,或者清掉筛选看全部。
            </p>
            <button
              type="button"
              onClick={s.clear}
              className="mt-5 rounded-lg border border-line bg-surface-2 px-4 py-2 text-xs text-neutral-200 transition-colors hover:border-accent"
            >
              清掉筛选
            </button>
          </div>
        )
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ContentCard key={item.contentId} item={item} />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * 记录里的一条:**你问的那句** + **这一问的结果**。
 *
 * 两行绑在同一个 `<li>` 里 —— 让"问"和"答"在结构上就分不开,
 * 而不是靠视觉上的相邻。
 */
function TurnRow({ turn, onRetry, onManual }: { turn: Turn; onRetry: () => void; onManual: () => void }) {
  const o = turn.outcome
  return (
    <li className="space-y-1">
      <div className="flex gap-3">
        <span className={ROW_LABEL}>你</span>
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-100">{turn.question}</p>
      </div>

      <div className="flex gap-3">
        <span className={ROW_LABEL}>{OUTCOME_LABEL[o.kind]}</span>
        <div className="min-w-0 flex-1">
          {o.kind === 'parsed' ? (
            <p className="text-xs leading-relaxed text-accent-soft">{o.conditions}</p>
          ) : (
            <p className="text-xs leading-relaxed text-muted">{OUTCOME_TEXT[o.kind === 'degraded' ? o.reason : 'failed']}</p>
          )}

          {/* ⚠️ `not_configured` **不给重试按钮** —— 理由见下面那张表的注释 */}
          {o.kind === 'failed' || (o.kind === 'degraded' && o.reason !== 'not_configured') ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-200 transition-colors hover:border-accent"
              >
                再试一次
              </button>
              <button
                type="button"
                onClick={onManual}
                className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-neutral-200 transition-colors hover:border-accent"
              >
                直接手动筛选
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/**
 * 左侧那个标签。⚠️ 它是**动作/角色**,不是说话人名字 —— 见文件头那段。
 *
 * `OUTCOME_TEXT` 把降级原因**分成三句不同的话**。这不是文案洁癖:
 * 合成一句的话,「没配密钥」(重试永远无效)和「模型超时」(重试很可能好)
 * 在界面上长得一模一样,用户没有任何依据决定要不要再点一次。
 * 2026-09-26 实测过那个状态,原来的文案确实是一字不差。
 */
const OUTCOME_LABEL: Record<Turn['outcome']['kind'], string> = {
  parsed: '解析',
  degraded: '没能解析',
  failed: '没能问上',
}

const OUTCOME_TEXT: Record<DegradeReason | 'failed', string> = {
  not_configured:
    '服务端没有配置模型密钥(ANTHROPIC_API_KEY),这个入口现在用不了 —— 所以上面那个问句框已经收起来了,再问一次也一样。下面那几个筛选项照样能用。',
  llm_unavailable: '模型这次没答应(超时或出错了)。可以再试一次;也可以直接在下面手动筛。',
  unparseable: '模型答了,但没给出能用的条件。再试一次通常就好;也可以直接在下面手动筛。',
  failed: '没能问上 —— 网络或服务端没应答。可以再试一次;也可以直接在下面手动筛。',
}

const ROW_LABEL = 'w-16 shrink-0 pt-0.5 text-[11px] text-muted'

/**
 * ⚠️ 与 `CreatePage.tsx` 里那个 `INPUT` 是**同一串视觉语言**,但这里是第二份。
 *
 * 如实记:没有把它抽成共享常量 —— 那一份是 `CreatePage` 的模块内私有量,
 * 抽出来要动它的表单,不在本包范围内。真要统一时,把两份一起收进
 * `src/components/` 下的一个 input 原语,别只抽一份。
 */
const INPUT =
  'w-full rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5 text-sm text-neutral-100 outline-none transition-colors placeholder:text-muted/60 focus:border-accent'

const LABEL = 'mb-1.5 block text-xs text-muted'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  )
}
