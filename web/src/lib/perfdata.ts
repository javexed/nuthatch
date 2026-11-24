// A plugin's performance data: read in one place, for the server (which
// keeps values for the graphs) and the interface alike.
export { type Perf, fraction, parsePerfdata } from '@nuthatch/api'

import type { Perf } from '@nuthatch/api'

/** Names plugins give their numbers that read better as words: what a
 * check of a web page or port calls `time` is how long it took to answer;
 * what checkd's aggregate calls `ok` is how many of its members are OK. */
const SAID: Record<string, string> = { time: 'latency', ok: 'members OK' }
export function labelText(label: string): string {
  return SAID[label] ?? label
}

/** A count out of a known number, as "3 of 4": a whole number without a
 * unit, from 0 to a maximum. Anything else is null. */
export function countText(value: number | undefined, perf: Pick<Perf, 'unit' | 'min' | 'max'> | undefined): string | null {
  if (value === undefined || !perf || perf.unit !== '' || perf.min !== 0 || perf.max === null) return null
  return Number.isInteger(value) && Number.isInteger(perf.max) && value >= 0 && value <= perf.max ? `${value} of ${perf.max}` : null
}
