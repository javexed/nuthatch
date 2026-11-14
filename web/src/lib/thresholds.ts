// A check's warning and critical thresholds, as plugins write them in
// performance data: `10` (alert outside 0..10), `10:` (below 10), `~:10`
// (above 10), `5:10` (outside 5..10), and `@5:10` (inside 5..10).

/** Whether a value is outside a threshold, so that it alerts. */
export function alerts(value: number, range: string): boolean {
  const text = range.trim()
  if (text === '') return false
  const inside = text.startsWith('@')
  const [lowText, highText] = (inside ? text.slice(1) : text).includes(':') ? (inside ? text.slice(1) : text).split(':', 2) : ['0', inside ? text.slice(1) : text]
  const low = lowText === '~' ? -Infinity : lowText === '' ? 0 : Number(lowText)
  const high = highText === undefined || highText === '' ? Infinity : Number(highText)
  if (Number.isNaN(low) || Number.isNaN(high)) return false
  const within = value >= low && value <= high
  return inside ? within : !within
}

/** 0 fine, 1 warning, 2 critical. */
export function level(value: number, warn: string, crit: string): 0 | 1 | 2 {
  if (alerts(value, crit)) return 2
  if (alerts(value, warn)) return 1
  return 0
}
