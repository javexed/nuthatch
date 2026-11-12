// How long hosts and services were in each state over a span of time,
// from the engines' state history.
//
// The engines count by the number of the state: for a service, warning,
// critical, unknown; for a host that reads down (1) and unreachable (2).
// The time before an engine knew of an object is "unmonitored" on Naemon;
// checkd counts it as the first state it knows. Percentages here leave
// unmonitored time out.

import type { Client, Stats } from '@nuthatch/api'
import type { Kind } from './states.ts'

export interface Availability {
  backend: string
  host: string
  service: string
  /** Seconds in each state, by its number: 0 OK or up, 1, 2, 3. */
  seconds: [number, number, number, number]
  unmonitored: number
}

/** The share of the monitored time spent in a state, 0 to 100; null when nothing was monitored. */
export function percent(row: Availability, state: number): number | null {
  const monitored = row.seconds.reduce((sum, s) => sum + s, 0)
  return monitored > 0 ? ((row.seconds[state] ?? 0) / monitored) * 100 : null
}

export function showPercent(value: number | null): string {
  if (value === null) return 'n/a'
  // 99.999 must not read as 100.
  const cut = Math.floor(value * 1000) / 1000
  return `${cut.toFixed(3)}%`
}

export interface Span {
  from: number
  to: number
}

export function availabilityRequest(kind: Kind, span: Span, narrowed: { host?: string; search?: string } = {}): Stats {
  const headers = [`Filter: time >= ${Math.floor(span.from)}`, `Filter: time < ${Math.floor(span.to)}`]
  headers.push(kind === 'host' ? 'Filter: service_description = ' : 'Filter: service_description != ')
  const clean = (text: string) => text.replace(/[\r\n]/g, ' ')
  if (narrowed.host) headers.push(`Filter: host_name = ${clean(narrowed.host)}`)
  if (narrowed.search?.trim()) {
    const text = clean(narrowed.search.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    headers.push(`Filter: host_name ~~ ${text}`)
    if (kind === 'service') headers.push(`Filter: service_description ~~ ${text}`, 'Or: 2')
  }
  for (const column of ['ok', 'warning', 'critical', 'unknown', 'unmonitored']) headers.push(`Stats: sum duration_${column}`)
  return { table: 'statehist', group_by: ['host_name', 'service_description'], headers }
}

export interface AvailabilityAnswer {
  rows: Availability[]
  errors: Record<string, string>
}

/** Asks for the availability of hosts or services over a span, worst first. */
export async function availability(api: Client, kind: Kind, span: Span, narrowed: { host?: string; search?: string; backends?: string[] } = {}): Promise<AvailabilityAnswer> {
  const answer = await api.stats({ ...availabilityRequest(kind, span, narrowed), backends: narrowed.backends })
  const rows: Availability[] = []
  for (const [backend, groups] of Object.entries(answer.by_backend)) {
    for (const { key, values } of groups) {
      const [ok = 0, warning = 0, critical = 0, unknown = 0, unmonitored = 0] = values
      rows.push({ backend, host: String(key[0] ?? ''), service: String(key[1] ?? ''), seconds: [ok, warning, critical, unknown], unmonitored })
    }
  }
  rows.sort((a, b) => (percent(a, 0) ?? 101) - (percent(b, 0) ?? 101) || a.host.localeCompare(b.host) || a.service.localeCompare(b.service) || a.backend.localeCompare(b.backend))
  return { rows, errors: answer.errors }
}

function field(value: string | number): string {
  const text = String(value)
  // A value that a spreadsheet would take for a formula is made plain text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** The rows as a CSV file's text. */
export function toCsv(kind: Kind, span: Span, rows: Availability[]): string {
  const states = kind === 'host' ? ['up', 'down', 'unreachable'] : ['ok', 'warning', 'critical', 'unknown']
  const head = ['backend', 'host', ...(kind === 'service' ? ['service'] : []), 'from', 'to', ...states.flatMap((s) => [`${s}_seconds`, `${s}_percent`]), 'unmonitored_seconds']
  const lines = [head.join(',')]
  for (const row of rows) {
    const cells: (string | number)[] = [row.backend, row.host, ...(kind === 'service' ? [row.service] : []), Math.floor(span.from), Math.floor(span.to)]
    states.forEach((_, n) => {
      const share = percent(row, n)
      cells.push(row.seconds[n] ?? 0, share === null ? '' : share.toFixed(3))
    })
    cells.push(row.unmonitored)
    lines.push(cells.map(field).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Ready-made spans, ending now. */
export const RANGES: { id: string; label: string; seconds: number }[] = [
  { id: '1h', label: 'Last hour', seconds: 3600 },
  { id: '24h', label: 'Last 24 hours', seconds: 86400 },
  { id: '7d', label: 'Last 7 days', seconds: 7 * 86400 },
  { id: '31d', label: 'Last 31 days', seconds: 31 * 86400 },
]
