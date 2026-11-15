// A plugin's performance data: read in one place, for the server (which
// keeps values for the graphs) and the interface alike.
export { type Perf, fraction, parsePerfdata } from '@nuthatch/api'

/** Names plugins give their numbers that read better as words: what a
 * check of a web page or port calls `time` is how long it took to answer. */
const SAID: Record<string, string> = { time: 'latency' }
export function labelText(label: string): string {
  return SAID[label] ?? label
}
