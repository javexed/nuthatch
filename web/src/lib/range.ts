// A span of time chosen on a page: one of the ready-made ones, ending
// now, or from one moment to another.

import { RANGES, type Span } from './availability.ts'

/** Reads `range=24h` or `from=<s>&to=<s>` off a page's address. */
export function spanOf(query: Record<string, unknown>, now: number, fallback = '24h'): { id: string; span: Span } {
  const from = Number(query.from)
  const to = Number(query.to)
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { id: 'custom', span: { from, to } }
  const range = RANGES.find((r) => r.id === query.range) ?? RANGES.find((r) => r.id === fallback) ?? RANGES[0]!
  return { id: range.id, span: { from: now - range.seconds, to: now } }
}
