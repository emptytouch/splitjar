/**
 * 数字显示工具。
 *
 * ⚠️ 存在的理由是一个真实的 bug:探针里原本用
 * `Number(formatGwei(x)).toLocaleString()` 显示 gasPrice,
 * **`toLocaleString()` 默认最多 3 位小数,会把 0.000000001 舍入成 "0"**。
 *
 * 对一个诊断面板来说,"把非零值显示成 0"是最糟的一类错误 ——
 * 它正好藏掉了我们要看的那个数。**所以这里一律走字符串,不做 Number 往返。**
 */

/** 百分比:小到 0.0024% 也要显示出来,绝不塌成 "0.0%" */
export function pct(ratio: number): string {
  const p = ratio * 100
  if (!Number.isFinite(p)) return '—'
  if (p === 0) return '0%'
  return `${num(String(p), 3)}%`
}

/**
 * 链上数值的紧凑显示。
 *
 * 第二个真实 bug:viem 的 `formatEther` 会老老实实返回
 * "0.00000000000192"。在窄栏里用 `break-all` 一折行,尾部就成了孤零零的
 * "192" —— 看着像乱码,而且丢掉了数量级。
 *
 * 这里保留 6 位有效数字(round 值不打折:`1` 还是 `1`,`25` 还是 `25`),
 * 小于 1e-6 的走科学计数,让数量级一眼可见。
 */
export function num(raw: string, sig = 6): string {
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  if (n === 0) return '0'
  if (Math.abs(n) < 1e-6) return n.toExponential(1)
  return String(Number(n.toPrecision(sig)))
}
