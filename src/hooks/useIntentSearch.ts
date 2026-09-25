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
 * | 模式 | 输入框的角色 | 谁填那三个筛选项 |
 * |---|---|---|
 * | 意图(`manual: false`) | 一句话 | 模型解析完**自动填进**筛选项 |
 * | 手动(`manual: true`) | 关键词 | 用户**自己填** |
 *
 * ⚠️ 这是本文件最重要的设计决定:**模型不直接产出结果,它只负责填那三个框。**
 * 于是"筛"这件事全仓只有一处(`shared/filterContents.ts`),不管是模型填的
 * 还是人填的。如果让模型走一条单独的筛选路径,两条路迟早对不上 ——
 * 而对不上的表现是"结果少了几件",像一个正常结果,不报错。
 *
 * ⇒ 副产品:**降级就是"那三个框改成手填"**,不是另写一套 UI(计划 §3.2)。
 *
 * ## ⚠️ 降级与"连不上"是两件事,处置完全不同
 *
 * | 情况 | 处置 | 为什么 |
 * |---|---|---|
 * | 服务端回 `degraded`(没配 key / 模型挂了) | **切成手动模式**,框留着 | 这是"这个功能今天没有",重试也不会好 |
 * | 连 200 都没拿到(function 被平台杀掉 / 网络断) | **留在意图模式**,可重试 | 这是"刚才那一下没成",重试很可能就好了 |
 *
 * 把两者合成一个"出错了"会让第二种情况白白降级掉一个能用的功能。
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

  /** 已经问过一次模型并拿到结果(决定要不要显示结果区) */
  const [asked, setAsked] = useState(false)
  /** 已切成手动模式。**只能单向进入** —— 没有"切回智能模式"这种动作 */
  const [manual, setManual] = useState(false)
  const [asking, setAsking] = useState(false)
  const [notice, setNotice] = useState<SearchNotice>(null)
  /** 降级时把用户问的那句原样回显出来 —— 否则它随着输入框清空就没影了 */
  const [degradedQuestion, setDegradedQuestion] = useState<string | null>(null)

  /** 手动模式下只要填了任何一项就开始筛(筛东西不该还要再点一下按钮) */
  const hasFields =
    fields.keyword.trim() !== '' || fields.min.trim() !== '' || fields.max.trim() !== '' || fields.limit.trim() !== ''

  const active = asked || (manual && hasFields)

  /**
   * 把三个输入框编译成筛选条件。
   *
   * ⚠️ **返回的是 `{filter, error}` 而不是抛异常**:这个 `useMemo` 每次按键都跑,
   * 抛出去会把整个组件打掉(错误边界里没有"用户正在打字"这种状态)。
   */
  const compiled = useMemo((): { filter: ContentFilter; error: null } | { filter: null; error: string } => {
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
  }, [fields])

  const results = useMemo(
    () => (active && compiled.filter !== null ? filterContents(items, compiled.filter) : null),
    [active, compiled, items],
  )

  /** 回显"我把你的话理解成了什么" —— 筛错了的唯一可见信号 */
  const summary = active && compiled.filter !== null ? describeFilter(compiled.filter) : null
  /** 一个条件都没提取到 —— 结果区的文案要换(见 shared/intent.ts 那段) */
  const emptyFilter = active && compiled.filter !== null ? isEmptyFilter(compiled.filter) : false

  const ask = useCallback(async () => {
    const query = text.trim()
    if (query === '' || asking) return

    setAsking(true)
    setNotice(null)

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
        setNotice({ kind: 'degraded', reason: data.reason })
        setDegradedQuestion(query)
        // ⚠️ **清空输入框**:它在手动模式下是**关键词框**,而那句完整的话
        // 当关键词用会一件都搜不到 —— 看起来就像"目录是空的"。那句话已经
        // 挪到提示里回显给用户看了
        setText('')
        return
      }

      setAsked(true)
      setDegradedQuestion(null)
      // 模型只负责填这三个框(见文件头)
      setFields({
        keyword: data.intent.keyword ?? '',
        min: data.intent.minPrice ?? '',
        max: data.intent.maxPrice ?? '',
        limit: data.intent.limit === null ? '' : String(data.intent.limit),
      })
      setText('')
    } catch {
      // ⚠️ 输入框**不清空**:重试就是把同一句话再问一次
      setNotice({ kind: 'failed' })
    } finally {
      setAsking(false)
    }
  }, [text, asking])

  const setField = useCallback((name: keyof SearchFields, value: string) => {
    setFields((prev) => ({ ...prev, [name]: value }))
  }, [])

  const clear = useCallback(() => {
    setText('')
    setFields(EMPTY_FIELDS)
    setAsked(false)
    setNotice(null)
    setDegradedQuestion(null)
  }, [])

  /** 「直接手动筛选」—— 意图模式里那个逃生口 */
  const useManual = useCallback(() => {
    setManual(true)
    setNotice(null)
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
    /** 问过一次并拿到结果 —— 决定要不要把那一排筛选项亮出来 */
    asked,
    /** 结果区要不要显示 */
    active,
    /** `null` = 没在筛(与"筛完为空数组"是两件事) */
    results,
    summary,
    emptyFilter,
    /** 价格框不合法时的短句 —— 非 null 时 `results` 一定是 `null` */
    priceError: compiled.error,
    notice,
    degradedQuestion,
    ask,
    clear,
    useManual,
  }
}

/** 三个筛选项 + 数量上限 —— 都存**用户敲的原文**,编译在 `compiled` 里做 */
export type SearchFields = {
  keyword: string
  min: string
  max: string
  limit: string
}

const EMPTY_FIELDS: SearchFields = { keyword: '', min: '', max: '', limit: '' }

/**
 * 顶部那条提示。
 *
 * ⚠️ `failed` 与 `degraded` **不同时存在**:能重试的就不降级(见文件头)。
 */
type SearchNotice = { kind: 'degraded'; reason: DegradeReason } | { kind: 'failed' } | null
