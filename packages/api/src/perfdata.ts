// A plugin's performance data, by the plugin guidelines:
// label=value[unit];[warn];[crit];[min];[max], separated by spaces, the
// label in single quotes when it holds spaces.

export interface Perf {
  label: string
  value: number
  unit: string
  warn: string
  crit: string
  min: number | null
  max: number | null
}

export function parsePerfdata(text: string): Perf[] {
  const out: Perf[] = []
  const part = /(?:'((?:[^']|'')*)'|([^\s=']+))=(\S*)/g
  for (const match of text.matchAll(part)) {
    const label = (match[1] ?? match[2] ?? '').replace(/''/g, "'")
    const [first = '', warn = '', crit = '', min = '', max = ''] = (match[3] ?? '').split(';')
    const number = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(first)
    if (!number || label === '') continue
    const optional = (s: string) => (s !== '' && Number.isFinite(Number(s)) ? Number(s) : null)
    out.push({ label, value: Number(number[0]), unit: first.slice(number[0].length), warn, crit, min: optional(min), max: optional(max) })
  }
  return out
}

/** How full a value is, 0 to 1, when its range is known. */
export function fraction(perf: Perf): number | null {
  const max = perf.unit === '%' ? (perf.max ?? 100) : perf.max
  const min = perf.min ?? 0
  if (max === null || max <= min) return null
  return Math.min(1, Math.max(0, (perf.value - min) / (max - min)))
}
