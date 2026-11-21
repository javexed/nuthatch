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

/**
 * The `label=value` parts, in one pass: what a monitored host writes here
 * is read on the server too, so no input may make it slow. A part that is
 * not one is skipped up to the next space.
 */
function parts(text: string): [label: string, value: string][] {
  const out: [string, string][] = []
  const space = /\s/
  const skip = (from: number) => {
    while (from < text.length && !space.test(text[from]!)) from++
    return from
  }
  // Once a quote is left open, no later one is looked for a close.
  let quotes = true
  let i = 0
  while (i < text.length) {
    while (i < text.length && space.test(text[i]!)) i++
    if (i >= text.length) break
    let label: string
    if (text[i] === "'") {
      let j = i + 1
      while (quotes && j < text.length && (text[j] !== "'" || text[j + 1] === "'")) j += text[j] === "'" ? 2 : 1
      if (!quotes || j >= text.length) {
        quotes = false
        i = skip(i)
        continue
      }
      label = text.slice(i + 1, j).replace(/''/g, "'")
      i = j + 1
    } else {
      const start = i
      while (i < text.length && text[i] !== '=' && text[i] !== "'" && !space.test(text[i]!)) i++
      label = text.slice(start, i)
    }
    if (text[i] !== '=') {
      i = skip(i)
      continue
    }
    const start = i + 1
    i = skip(start)
    out.push([label, text.slice(start, i)])
  }
  return out
}

export function parsePerfdata(text: string): Perf[] {
  const out: Perf[] = []
  for (const [label, value] of parts(text)) {
    const [first = '', warn = '', crit = '', min = '', max = ''] = value.split(';')
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
