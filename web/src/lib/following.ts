// What the panels that follow a dashboard's subject ask the engines: the
// members of a group, and the lines of a graph.
import type { CheckNumber, Series } from '@nuthatch/api'
import { api } from '../stores/session'
import { parsePerfdata } from './perfdata'
import type { Focus } from './subjects'

const clean = (text: string) => text.replace(/[\r\n]/g, ' ')

/** The hosts, or services, a log that follows is about; null for everything. */
export async function membersOf(focus: Focus | null): Promise<{ host: string; service?: string }[] | null> {
  if (!focus) return null
  if (focus.kind === 'host') return [{ host: focus.host }]
  if (focus.kind === 'hostgroup') {
    const rows = (await api.query({ table: 'hosts', columns: ['name'], headers: [`Filter: groups >= ${clean(focus.name)}`], limit: 100 })).rows
    return rows.map((r) => ({ host: String(r.name) }))
  }
  const rows = (await api.query({ table: 'services', columns: ['host_name', 'description'], headers: [`Filter: groups >= ${clean(focus.name)}`], limit: 100 })).rows
  return rows.map((r) => ({ host: String(r.host_name), service: String(r.description) }))
}

const MAX_LINES = 8

/** The lines of a following graph: each number, of whatever is chosen
 * that has it; at most 8. A number of no service in particular is, for a
 * service group, of any of its services. */
export async function seriesOf(numbers: CheckNumber[], focus: Focus | null): Promise<Series[]> {
  const out: Series[] = []
  for (const n of numbers) {
    if (out.length >= MAX_LINES) break
    const headers: string[] = ['Filter: perf_data != ']
    let table: 'hosts' | 'services' = n.service === undefined ? 'hosts' : 'services'
    if (focus?.kind === 'servicegroup') {
      table = 'services'
      headers.push(`Filter: groups >= ${clean(focus.name)}`)
      if (n.service !== undefined) headers.push(`Filter: description = ${clean(n.service)}`)
    } else {
      if (n.service !== undefined) headers.push(`Filter: description = ${clean(n.service)}`)
      if (focus?.kind === 'host') headers.push(`Filter: ${table === 'hosts' ? 'name' : 'host_name'} = ${clean(focus.host)}`)
      if (focus?.kind === 'hostgroup') headers.push(`Filter: ${table === 'hosts' ? 'groups' : 'host_groups'} >= ${clean(focus.name)}`)
    }
    const columns = table === 'hosts' ? ['name', 'perf_data'] : ['host_name', 'description', 'perf_data']
    const answer = await api.query({ table, columns, headers, sort: [{ column: table === 'hosts' ? 'name' : 'host_name' }], limit: 50, ...(focus?.kind === 'host' ? { backends: [focus.backend] } : {}) })
    for (const r of answer.rows) {
      if (out.length >= MAX_LINES) break
      if (!parsePerfdata(String(r.perf_data)).some((p) => p.label === n.label)) continue
      const host = String(table === 'hosts' ? r.name : r.host_name)
      out.push({ backend: r.backend, host, ...(table === 'services' ? { service: String(r.description) } : {}), label: n.label })
    }
  }
  return out
}
