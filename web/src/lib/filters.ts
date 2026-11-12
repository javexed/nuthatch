// What a list is narrowed to, as the page's address holds it and as the
// Livestatus filter lines the server takes.

import type { Kind } from './states.ts'

export interface ListFilter {
  /** The states shown; all when empty. For a service, 0 to 3; a host, 0 to 2. */
  states: number[]
  /** Text looked for in names and output, whatever the case. */
  search: string
  /** Only what nobody has taken care of: not acknowledged, not in a downtime. */
  unhandled: boolean
  /** A host group, or for services a service group. */
  group: string
  /** For services: of this host only. */
  host: string
  /** A host group whose hosts' services are meant. */
  hostgroup: string
}

export const EMPTY: ListFilter = { states: [], search: '', unhandled: false, group: '', host: '', hostgroup: '' }

/** A text as a regular expression that matches it literally. */
export function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function any(lines: string[]): string[] {
  return lines.length > 1 ? [...lines, `Or: ${lines.length}`] : lines
}

export function toHeaders(kind: Kind, filter: ListFilter): string[] {
  const out: string[] = []
  const max = kind === 'host' ? 2 : 3
  const wanted = [...new Set(filter.states)].filter((s) => Number.isInteger(s) && s >= 0 && s <= max)
  out.push(...any(wanted.map((s) => `Filter: state = ${s}`)))
  const search = filter.search.trim().replace(/[\r\n]/g, ' ')
  if (search !== '') {
    const columns = kind === 'host' ? ['name', 'alias', 'address', 'plugin_output'] : ['host_name', 'description', 'plugin_output']
    out.push(...any(columns.map((c) => `Filter: ${c} ~~ ${literal(search)}`)))
  }
  if (filter.unhandled) {
    out.push('Filter: acknowledged = 0', 'Filter: scheduled_downtime_depth = 0')
    if (kind === 'service') out.push('Filter: host_acknowledged = 0', 'Filter: host_scheduled_downtime_depth = 0')
  }
  const name = (text: string) => text.replace(/[\r\n]/g, ' ')
  if (filter.group !== '') out.push(`Filter: groups >= ${name(filter.group)}`)
  if (kind === 'service' && filter.host !== '') out.push(`Filter: host_name = ${name(filter.host)}`)
  if (kind === 'service' && filter.hostgroup !== '') out.push(`Filter: host_groups >= ${name(filter.hostgroup)}`)
  return out
}

type QueryLike = Record<string, unknown>

/** Reads a filter from the address of a page. */
export function fromQuery(query: QueryLike): ListFilter {
  const text = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : '')
  return {
    states: text('state').split(',').filter((s) => /^\d$/.test(s)).map(Number),
    search: text('q'),
    unhandled: text('unhandled') === '1',
    group: text('group'),
    host: text('host'),
    hostgroup: text('hostgroup'),
  }
}

/** A filter as the address of a page holds it: only what is set. */
export function toQuery(filter: ListFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (filter.states.length > 0) out.state = [...filter.states].sort().join(',')
  if (filter.search.trim() !== '') out.q = filter.search.trim()
  if (filter.unhandled) out.unhandled = '1'
  if (filter.group !== '') out.group = filter.group
  if (filter.host !== '') out.host = filter.host
  if (filter.hostgroup !== '') out.hostgroup = filter.hostgroup
  return out
}
