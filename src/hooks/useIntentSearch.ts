import { useCallback, useMemo, useState } from 'react'
import type { CatalogEntry } from '../../shared/agentPay'
import { AmountError } from '../../shared/units'
import {
  type ContentFilter,
  describeFilter,
  filterContents,
  isEmptyFilter,
  normalizeKeyword,
  normalizeLimit,
  parsePriceBound,
} from '../../shared/filterContents'
import { MAX_QUERY_LENGTH, type DegradeReason, type IntentParseResult } from '../../shared/intent'

/**
 * `/explore` 顶部那个搜索框的全部状态(W14 包 A)。
 *
 * ## ⭐ 两种模式,**一条筛选路径**
 *
 * | 模式 | 输入框的角色 | 谁填那几个筛选项 |
 * |---|---|---|
 * | 意图(`manual: false`) | 一句话 | 模型解析完**自动填进**筛选项 |
 * | 手动(`manual: true`) | 关键词 | 用户**自己填** |
 *
 * ⚠️ 这是本文件最重要的设计决定:**模型不直接产出结果,它只负责填那几个框。**
 * 于是"筛"这件事全仓只有一处(`shared/filterContents.ts`),不管是模型填的
 * 还是人填的。如果让模型走一条单独的筛选路径,两条路迟早对不上 ——
 * 而对不上的表现是"结果少了几件",像一个正常结果,不报错。
 *
 * ⇒ 副产品:**降级就是"那几个框改成手填"**,不是另写一套 UI(计划 §3.2)。
 *
 * ## ⚠️ 2026-09-26 改版:提示条 → **记录流**(`turns`)
 *
 * 原先只有一条"当前提示"(`notice`),于是**第二次问就把第一次的痕迹抹掉了**,
 * 而且 `degraded` 的两种原因(没配 key / 模型挂了)在界面上**文案一字不差**,
 * 用户分不出"该不该再点一次"。现在每次问都往 `turns` 里追加一条,
 * 问答成对留在屏幕上:
 *
 * ```
 * 你      0.5 以下的图
 * 解析    关键词「图」· ≤ 0.5 USDC
 * ```
 *
 * ⚠️ **做的是"记录",不是"对话气泡"** —— 见 `IntentSearch.tsx` 文件头那段:
 * 气泡会读成"有人在跟你说话",而这里没有第二个人。
 *
 * ## ⚠️ 三种结局,处置各不相同
 *
 * | 结局 | 问句框 | 记录里那一行给什么 |
 * |---|---|---|
 * | `parsed` | 留着 | 解析出的条件 |
 * | `degraded` · `not_configured` | **收掉** | 明说服务端没配密钥,**不给重试** |
 * | `degraded` · `llm_unavailable` / `unparseable` | 留着 | **给「再试一次」** |
 * | `failed`(连 200 都没拿到) | 留着 | **给「再试一次」+「直接手动筛选」** |
 *
 * ⚠️ **`not_configured` 必须把问句框收掉**,这是它和另外两种降级的**唯一区别**:
 * 一个永远不会成功的按钮比没有按钮更糟(2026-09-26 实测:收掉之前,
 * 用户降级后还能接着往框里打字、按钮会活过来、点下去必然再失败一次)。
 *
 * ## ⚠️ 价格框的输入校验**必须在这里**,不能等筛的时候
 *
 * `parsePriceBound` 抛 `AmountError` 时,`results` 是 `null`(不是空数组)——
 * 界面上那是"**输入不合法,没在筛**",和"筛完一件不剩"必须分开显示。
 * 把非法输入当成 0 会让结果直接筛空,而用户看到的是"没找到"。
 */
export function useIntentSearch(items: readonly CatalogEntry[]) {
  /** 用户敲的那句话 / 手动模式下的关键词 —— 同一个输入框,两种角色 */
  const [text, setText] = useState('')
  const [fields, setFields] = useState<SearchFields>(EMPTY_FIELDS)
  /** 问答记录,只追加。`clear()` **不清它** —— 清的是筛选条件,不是历史 */
  const [turns, setTurns] = useState<Turn[]>([])

  /** 已经问出过一次解析结果,且它还在生效(决定要不要显示结果区) */
  const [asked, setAsked] = useState(false)
  /** 已切成手动模式。**只能单向进入** —— 没有"切回智能模式"这种动作 */
  const [manual, setManual] = useState(false)
  const [asking, setAsking] = useState(false)

  /** 手动模式下只要填了任何一项就开始筛(筛东西不该还要再点一下按钮) */
  const hasFields =
    fields.keyword.trim() !== '' || fields.min.trim() !== '' || fields.max.trim() !== '' || fields.limit.trim() !== ''

  const active = asked || (manual && hasFields)

  /**
   * 服务端明确说过"这个入口今天没有"(没配模型密钥)⇒ **把问句框收掉**。
   *
   * ⚠️ 只看 `not_configured`。`llm_unavailable` 是"这一下没成",重试有意义,
   * 框必须留着 —— 把两者合成一个布尔会让偶发失败也白白丢掉重试入口。
   */
  const parseUnavailable = turns.some((t) => t.outcome.kind === 'degraded' && t.outcome.reason === 'not_configured')

  /**
   * 把那几个输入框编译成筛选条件。
   *
   * ⚠️ **返回的是 `{filter, error}` 而不是抛异常**:这个函数每次按键都跑,
   * 抛出去会把整个组件打掉(错误边界里没有"用户正在打字"这种状态)。
   *
   * ⚠️ 它是**模块级的纯函数**、不是 hook 里的闭包,因为解析成功那一刻要拿
   * 同一套规则把"模型理解成了什么"算成一句快照写进记录里 —— 快照和真正的筛选
   * 走**同一个函数**,才能保证记录里写的就是实际在筛的。
   */
  const compiled = useMemo(() => compileFields(fields), [fields])

  const results = useMemo(
    () => (active && compiled.filter !== null ? filterContents(items, compiled.filter) : null),
    [active, compiled, items],
  )

  /** 回显"我把你的话理解成了什么" —— 筛错了的唯一可见信号 */
  const summary = active && compiled.filter !== null ? describeFilter(compiled.filter) : null
  /** 一个条件都没提取到 —— 结果区的文案要换(见 shared/intent.ts 那段) */
  const emptyFilter = active && compiled.filter !== null ? isEmptyFilter(compiled.filter) : false

  const pushTurn = useCallback((question: string, outcome: TurnOutcome) => {
    // id 从 `prev` 推出来,不用外部计数器 —— 更新函数保持纯的(StrictMode 会重放)
    setTurns((prev) => [...prev, { id: (prev.at(-1)?.id ?? 0) + 1, question, outcome }])
  }, [])

  /**
   * 问一次。`sentence` 省略时用输入框里的内容 —— 记录里那行「再试一次」
   * 会把当时那句原话传回来(那时输入框已经清空了)。
   */
  const ask = useCallback(
    async (sentence?: string) => {
      const query = (sentence ?? text).trim()
      if (query === '' || asking) return

      setAsking(true)
      try {
        const res = await fetch('/api/parse-intent', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        })
        // 服务端对"解析"这件事**永远回 200**(计划 §9.1),所以 4xx/5xx 是
        // 真出了别的事 —— 归到"没问上",不归到降级
        if (!res.ok) throw new Error(`parse_${res.status}`)

        const data = (await res.json()) as IntentParseResult

        if (data.kind === 'degraded') {
          setManual(true)
          pushTurn(query, { kind: 'degraded', reason: data.reason })
          return
        }

        // 模型只负责填那几个框(见文件头)
        const next: SearchFields = {
          keyword: data.intent.keyword ?? '',
          min: data.intent.minPrice ?? '',
          max: data.intent.maxPrice ?? '',
          limit: data.intent.limit === null ? '' : String(data.intent.limit),
        }
        setFields(next)
        setAsked(true)
        // 快照:这一刻模型把它理解成了什么。与真正的筛选同一套规则(见 `compileFields`)
        const snapshot = compileFields(next)
        pushTurn(query, {
          kind: 'parsed',
          conditions:
            snapshot.filter === null
              ? '条件没法用'
              : isEmptyFilter(snapshot.filter)
                ? '没提取到具体条件'
                : describeFilter(snapshot.filter),
        })
      } catch {
        pushTurn(query, { kind: 'failed' })
      } finally {
        setAsking(false)
        // ⚠️ 三种结局**都清空**:那句原话已经进记录了,重试走记录里那个按钮。
        // 留着的害处实测过 —— 降级之后它在手动模式里是**关键词框**,
        // 而一整句话当关键词用会一件都搜不到,看起来像"目录是空的"。
        setText('')
      }
    },
    [text, asking, pushTurn],
  )

  const setField = useCallback((name: keyof SearchFields, value: string) => {
    setFields((prev) => ({ ...prev, [name]: value }))
  }, [])

  /**
   * 清掉筛选条件。
   *
   * ⚠️ **不重置 `manual`**(它是单向的,见上),也**不清 `turns`** ——
   * 清掉的是"现在在筛什么",不是"你问过什么"。清 `manual` 会让降级之后
   * 那几个手填框跟着消失,用户就彻底没有筛的入口了。
   */
  const clear = useCallback(() => {
    setText('')
    setFields(EMPTY_FIELDS)
    setAsked(false)
  }, [])

  /** 「直接手动筛选」—— 意图模式里那个逃生口 */
  const useManual = useCallback(() => {
    setManual(true)
  }, [])

  return {
    text,
    setText,
    fields,
    setField,
    /** 给输入框 `maxLength` 用 —— 与服务端同一份上限,别在组件里再写一个数 */
    maxQueryLength: MAX_QUERY_LENGTH,
    asking,
    manual,
    /** 问过一次并拿到解析结果 —— 决定要不要把那一排筛选项亮出来 */
    asked,
    /** 问答记录(只追加) */
    turns,
    /** 服务端说了"没配模型密钥" ⇒ 问句框收掉,不给重试(见文件头那张表) */
    parseUnavailable,
    /** 结果区要不要显示 */
    active,
    /** `null` = 没在筛(与"筛完为空数组"是两件事) */
    results,
    summary,
    emptyFilter,
    /** 价格框不合法时的短句 —— 非 null 时 `results` 一定是 `null` */
    priceError: compiled.error,
    ask,
    clear,
    useManual,
  }
}

/**
 * 输入框原文 → 筛选条件。`error` 非 null 时 `filter` 一定是 null(两者互斥)。
 *
 * 提成模块级纯函数是为了让"记录里的快照"和"真正在筛的"共用同一套规则
 * (见 `useIntentSearch` 里 `compiled` 那段)。
 */
export function compileFields(fields: SearchFields): { filter: ContentFilter; error: null } | { filter: null; error: string } {
  try {
    const minRaw = parsePriceBound(fields.min)
    const maxRaw = parsePriceBound(fields.max)

    // ⚠️ 区间反了要**当场说**。不说的话结果是空的,而那看起来像"没有这种东西"
    if (minRaw !== null && maxRaw !== null && minRaw > maxRaw) {
      return { filter: null, error: '最低价比最高价还高' }
    }

    return {
      filter: {
        keyword: normalizeKeyword(fields.keyword),
        minRaw,
        maxRaw,
        limit: fields.limit.trim() === '' ? null : normalizeLimit(Number(fields.limit)),
      },
      error: null,
    }
  } catch (error) {
    // `AmountError` 的 message 是给人看的短句(见 shared/units.ts),直接用
    return { filter: null, error: error instanceof AmountError ? error.message : '价格填得不对' }
  }
}

/** 几个筛选项 + 数量上限 —— 都存**用户敲的原文**,编译交给 `compileFields` */
export type SearchFields = {
  keyword: string
  min: string
  max: string
  limit: string
}

const EMPTY_FIELDS: SearchFields = { keyword: '', min: '', max: '', limit: '' }

/**
 * 一条问答记录。
 *
 * ⚠️ `outcome` 与 `IntentParseResult` **不同构**:后端多出一个 `failed`
 * (连 200 都没拿到)。把它并进后端的联合类型会把"服务端没应答"这种事
 * 也算成"服务端说了什么",而这两件事的处置**正好相反**(见文件头那张表)。
 */
export type Turn = {
  id: number
  question: string
  outcome: TurnOutcome
}

export type TurnOutcome =
  | { kind: 'parsed'; conditions: string }
  | { kind: 'degraded'; reason: DegradeReason }
  | { kind: 'failed' }
