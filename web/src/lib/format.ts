// Times and durations as people read them.

/** "3d 4h", "5m 12s": the two largest units. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const units: [string, number][] = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]
  const parts: string[] = []
  let left = Math.floor(seconds)
  for (const [name, size] of units) {
    if (left >= size || (name === 's' && parts.length === 0)) {
      parts.push(`${Math.floor(left / size)}${name}`)
      left %= size
    } else if (parts.length > 0) {
      parts.push('')
    }
    if (parts.length === 2) break
  }
  return parts.filter((p) => p !== '').join(' ')
}

/** How long ago a moment was; "never" for 0. */
export function ago(timestamp: number, now: number = Date.now() / 1000): string {
  if (!timestamp) return 'never'
  const d = now - timestamp
  return d < 0 ? `in ${duration(-d)}` : `${duration(d)} ago`
}

export function dateTime(timestamp: number): string {
  if (!timestamp) return 'never'
  const d = new Date(timestamp * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** The value of a datetime-local input, for a moment. */
export function toInput(timestamp: number): string {
  return dateTime(timestamp).replace(' ', 'T').slice(0, 16)
}

/** The moment a datetime-local input holds, in seconds; NaN when empty. */
export function fromInput(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000)
}
