// What a panel's settings can be chosen from, asked of the engines.
import { type Ref, ref, watch } from 'vue'
import { api } from '../stores/session'
import { parsePerfdata } from './perfdata'

const oneLine = (text: string) => !/[\r\n]/.test(text)

async function names(table: string, column: string, backend?: string, headers: string[] = []): Promise<string[]> {
  const answer = await api.query({ table, columns: [column], headers, sort: [{ column }], limit: 5000, ...(backend ? { backends: [backend] } : {}) })
  return [...new Set(answer.rows.map((r) => String(r[column])))]
}

export function hostGroups(): Promise<string[]> {
  return names('hostgroups', 'name')
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
