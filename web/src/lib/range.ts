// A span of time chosen on a page: one of the ready-made ones, ending
// now, or from one moment to another.

import { RANGES as DASH_RANGES, type Range } from '@nuthatch/api'
import { RANGES, type Span } from './availability.ts'

/** Reads `range=24h` or `from=<s>&to=<s>` off a page's address. */
export function spanOf(query: Record<string, unknown>, now: number, fallback = '24h'): { id: string; span: Span } {
  const from = Number(query.from)
  const to = Number(query.to)
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { id: 'custom', span: { from, to } }
  const range = RANGES.find((r) => r.id === query.range) ?? RANGES.find((r) => r.id === fallback) ?? RANGES[0]!
  return { id: range.id, span: { from: now - range.seconds, to: now } }
}

/** What a dashboard looks at: one of its ranges (ending now, or of the
 * calendar), or from one moment to another. */
export type When = { range: Range } | Span

/** The span `when` is now, in seconds, by the looker's calendar. `live`:
 * it ends now, and moves on. */
export function spanNow(when: When, now = Date.now() / 1000): Span & { live: boolean } {
  if (!('range' in when)) return { ...when, live: false }
  const seconds = DASH_RANGES[when.range]?.seconds
  if (seconds !== undefined) return { from: now - seconds, to: now, live: true }
  const day = new Date(now * 1000)
  day.setHours(0, 0, 0, 0)
  const midnight = day.getTime() / 1000
  switch (when.range) {
    case 'today':
      return { from: midnight, to: now, live: true }
    case 'yesterday': {
      const before = new Date(day)
      before.setDate(before.getDate() - 1)
      return { from: before.getTime() / 1000, to: midnight, live: false }
    }
    case 'week': {
      // From Monday.
      const monday = new Date(day)
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
      return { from: monday.getTime() / 1000, to: now, live: true }
    }
    default: {
      const first = new Date(day)
      first.setDate(1)
      const previous = new Date(first)
      previous.setMonth(previous.getMonth() - 1)
      return { from: previous.getTime() / 1000, to: first.getTime() / 1000, live: false }
    }
  }
}

/** A span as people read it: "14 Nov 10:00 – 12:00", the day said once. */
export function spanText(span: Span): string {
  const a = new Date(span.from * 1000)
  const b = new Date(span.to * 1000)
  const day = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return day(a) === day(b) ? `${day(a)} ${time(a)} – ${time(b)}` : `${day(a)} ${time(a)} – ${day(b)} ${time(b)}`
}
