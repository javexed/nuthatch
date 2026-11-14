// What a panel's settings can be chosen from, asked of the engines: hosts,
// a host's services, host groups, and the numbers a check reports.
import { type Ref, ref, watch } from 'vue'
import { api } from '../stores/session'
import { parsePerfdata } from './perfdata'

export interface Metric {
  label: string
  /** The number now, with its unit, to choose by. */
  now: string
}

const oneLine = (text: string) => !/[\r\n]/.test(text)

async function names(table: string, column: string, backend?: string, headers: string[] = []): Promise<string[]> {
  const answer = await api.query({ table, columns: [column], headers, sort: [{ column }], limit: 5000, ...(backend ? { backends: [backend] } : {}) })
  return [...new Set(answer.rows.map((r) => String(r[column])))]
}

export function hostsOf(backend: string): Promise<string[]> {
  return names('hosts', 'name', backend)
}

export function servicesOf(backend: string, host: string): Promise<string[]> {
  return oneLine(host) ? names('services', 'description', backend, [`Filter: host_name = ${host}`]) : Promise.resolve([])
}

export function hostGroups(): Promise<string[]> {
  return names('hostgroups', 'name')
}

/** The numbers in a host's or service's performance data now. */
export async function metricsOf(backend: string, host: string, service?: string): Promise<Metric[]> {
  if (!oneLine(host) || (service !== undefined && !oneLine(service))) return []
  const answer = await api.query({
    table: service ? 'services' : 'hosts',
    columns: ['perf_data'],
    headers: service ? [`Filter: host_name = ${host}`, `Filter: description = ${service}`] : [`Filter: name = ${host}`],
    backends: [backend],
  })
  return parsePerfdata(String(answer.rows[0]?.perf_data ?? '')).map((p) => ({ label: p.label, now: `${p.value}${p.unit}` }))
}

/** A list that follows its inputs; empty while they are not set. */
export function useList<T>(inputs: () => unknown[], load: () => Promise<T[]> | null): Ref<T[] | null> {
  const list = ref<T[] | null>(null) as Ref<T[] | null>
  let asked = 0
  watch(
    inputs,
    async () => {
      const mine = ++asked
      const loading = load()
      if (!loading) {
        list.value = null
        return
      }
      try {
        const found = await loading
        if (mine === asked) list.value = found
      } catch {
        if (mine === asked) list.value = null
      }
    },
    { immediate: true },
  )
  return list
}

/** A host's or service's performance data now, with its thresholds. */
export async function perfOf(target: { backend: string; host: string; service?: string }) {
  if (!oneLine(target.host) || (target.service !== undefined && !oneLine(target.service))) return []
  const answer = await api.query({
    table: target.service ? 'services' : 'hosts',
    columns: ['perf_data'],
    headers: target.service ? [`Filter: host_name = ${target.host}`, `Filter: description = ${target.service}`] : [`Filter: name = ${target.host}`],
    backends: [target.backend],
  })
  return parsePerfdata(String(answer.rows[0]?.perf_data ?? ''))
}
