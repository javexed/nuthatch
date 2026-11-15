<script setup lang="ts">
// One picker for what a panel shows. Before anything is typed it is a list
// to browse: everything, the host groups, the hosts (› for a host's
// services or numbers). Typing a few words narrows it to every host group,
// host, service or number whose names have them all.
//
// `scope`: all hosts, a group, a host or a service. `series`: a number of
// a host or service. `place`: a host group or a host.
import type { Scope, Series } from '@nuthatch/api'
import { computed, onMounted, ref, watch } from 'vue'
import { literal } from '../lib/filters'
import { labelText, parsePerfdata } from '../lib/perfdata'
import { api, useSession } from '../stores/session'

const props = defineProps<{ mode: 'scope' | 'series' | 'place'; chooser?: boolean; label?: string; focus?: boolean }>()
const emit = defineEmits<{ scope: [scope: Scope]; series: [series: Series] }>()
const box = ref<HTMLInputElement>()
onMounted(() => props.focus && box.value?.focus())

interface Found {
  key: string
  text: string
  detail?: string
  pick?: () => void
  /** A host whose services or numbers can be opened. */
  open?: { backend: string; host: string; service?: string }
  /** A heading in the list, not a choice. */
  head?: boolean
}

const session = useSession()
/** With more than one backend, each result says whose it is. */
const whose = (backend: string, detail?: string) => ((session.session?.backends.length ?? 0) > 1 ? [detail, backend].filter(Boolean).join(' · ') : detail)
const words = ref('')
/** The host (or service, for numbers) opened from the list. */
const inside = ref<{ backend: string; host: string; service?: string } | null>(null)
const found = ref<Found[]>([])
let asked = 0

const clean = (w: string) => literal(w.replace(/[\r\n]/g, ' '))
/** Every word in one of these columns. */
const each = (list: string[], columns: string[]) => list.flatMap((w) => [...columns.map((c) => `Filter: ${c} ~~ ${clean(w)}`), ...(columns.length > 1 ? [`Or: ${columns.length}`] : [])])
const has = (text: string, list: string[]) => list.every((w) => text.toLowerCase().includes(w.toLowerCase()))
const ofHost = (host: string) => `Filter: host_name = ${clean(host)}`

const scope = (s: Scope) => () => emit('scope', s)
const groupRow = (g: string, detail?: string): Found => ({
  key: `g\n${g}`,
  text: g,
  detail: detail ?? 'host group',
  pick: scope({ hostgroup: g }),
})

/** The numbers of one host or service, to pick from. */
async function numbersOf(at: { backend: string; host: string; service?: string }): Promise<Found[]> {
  const answer = await api.query({
    table: at.service ? 'services' : 'hosts',
    columns: ['perf_data'],
    headers: at.service ? [`Filter: host_name = ${clean(at.host)}`, `Filter: description = ${clean(at.service)}`] : [`Filter: name = ${clean(at.host)}`],
    backends: [at.backend],
  })
  return parsePerfdata(String(answer.rows[0]?.perf_data ?? '')).map((p) => ({
    key: `n\n${p.label}`,
    text: labelText(p.label),
    detail: `${p.value}${p.unit}`,
    pick: () => emit('series', { backend: at.backend, host: at.host, ...(at.service ? { service: at.service } : {}), label: p.label }),
  }))
}

/** Inside a host: the host itself and its services, or (for numbers) those with any. */
async function insideHost(at: { backend: string; host: string; service?: string }): Promise<Found[]> {
  if (props.mode === 'series') {
    if (at.service !== undefined) return numbersOf(at)
    const [own, services] = await Promise.all([
      numbersOf({ backend: at.backend, host: at.host }),
      api.query({ table: 'services', columns: ['description'], headers: [ofHost(at.host), 'Filter: perf_data != '], sort: [{ column: 'description' }], backends: [at.backend], limit: 200 }),
    ])
    return [
      ...own,
      ...services.rows.map((r) => {
        const service = String(r.description)
        return { key: `s\n${service}`, text: service, open: { backend: at.backend, host: at.host, service } }
      }),
    ]
  }
  const services = await api.query({ table: 'services', columns: ['description'], headers: [ofHost(at.host)], sort: [{ column: 'description' }], backends: [at.backend], limit: 500 })
  return [
    { key: 'h', text: at.host, detail: 'the host', pick: scope({ of: { backend: at.backend, host: at.host } }) },
    ...services.rows.map((r) => {
      const service = String(r.description)
      return { key: `s\n${service}`, text: service, pick: scope({ of: { backend: at.backend, host: at.host, service } }) }
    }),
  ]
}

/** Nothing typed: a list to browse. */
async function browse(): Promise<Found[]> {
  const out: Found[] = []
  if (props.mode === 'scope' && props.chooser) out.push({ key: '$host', text: 'The chosen host', pick: scope({ of: { backend: '$host', host: '$host' } }) })
  if (props.mode === 'scope') out.push({ key: 'all', text: 'All hosts', pick: scope({}) })
  if (props.mode !== 'series') {
    const groups = await api.query({ table: 'hostgroups', columns: ['name', 'num_hosts'], sort: [{ column: 'name' }], limit: 200 })
    const seen = new Set<string>()
    const rows = groups.rows.filter((r) => !seen.has(String(r.name)) && seen.add(String(r.name)))
    if (rows.length > 0) out.push({ key: 'head-g', text: 'Host groups', head: true })
    for (const r of rows) out.push(groupRow(String(r.name), `${Number(r.num_hosts)} host${Number(r.num_hosts) === 1 ? '' : 's'}`))
  }
  const series = props.mode === 'series'
  const hosts = series
    ? // Those with numbers, of their own or of a service.
      await api.query({ table: 'services', columns: ['host_name'], headers: ['Filter: perf_data != '], sort: [{ column: 'host_name' }], limit: 5000 })
    : await api.query({ table: 'hosts', columns: ['name'], sort: [{ column: 'name' }], limit: 100 })
  const seen = new Set<string>()
  const list = hosts.rows
    .map((r) => ({ backend: r.backend, host: String((r as Record<string, unknown>)[series ? 'host_name' : 'name']) }))
    .filter((h) => !seen.has(`${h.backend}\n${h.host}`) && seen.add(`${h.backend}\n${h.host}`))
    .slice(0, 100)
  if (list.length > 0 && !series) out.push({ key: 'head-h', text: 'Hosts', head: true })
  for (const h of list) {
    out.push({
      key: `h\n${h.backend}\n${h.host}`,
      text: h.host,
      detail: whose(h.backend),
      ...(props.mode === 'place' ? { pick: scope({ of: { backend: h.backend, host: h.host } }) } : props.mode === 'scope' ? { pick: scope({ of: { backend: h.backend, host: h.host } }), open: h } : { open: h }),
    })
  }
  return out
}

async function search(list: string[]): Promise<Found[]> {
  const out: Found[] = []
  if (props.mode === 'scope') {
    if (props.chooser && has('chosen host', list)) out.push({ key: '$host', text: 'The chosen host', pick: scope({ of: { backend: '$host', host: '$host' } }) })
    if (has('all hosts', list)) out.push({ key: 'all', text: 'All hosts', pick: scope({}) })
  }
  if (props.mode !== 'series') {
    const groups = await api.query({ table: 'hostgroups', columns: ['name'], headers: each(list, ['name', 'alias']), sort: [{ column: 'name' }], limit: 20 })
    for (const g of new Set(groups.rows.map((r) => String(r.name)))) out.push(groupRow(g))
    const [hosts, services] = await Promise.all([
      api.query({ table: 'hosts', columns: ['name'], headers: each(list, ['name', 'alias', 'address']), sort: [{ column: 'name' }], limit: 20 }),
      props.mode === 'scope' ? api.query({ table: 'services', columns: ['host_name', 'description'], headers: each(list, ['host_name', 'description']), sort: [{ column: 'host_name' }, { column: 'description' }], limit: 30 }) : null,
    ])
    for (const r of hosts.rows) {
      const host = String(r.name)
      out.push({ key: `h\n${r.backend}\n${host}`, text: host, detail: whose(r.backend, 'host'), pick: scope({ of: { backend: r.backend, host } }) })
    }
    for (const r of services?.rows ?? []) {
      const host = String(r.host_name)
      const service = String(r.description)
      out.push({ key: `s\n${r.backend}\n${host}\n${service}`, text: `${host} · ${service}`, detail: whose(r.backend), pick: scope({ of: { backend: r.backend, host, service } }) })
    }
    return out
  }
  // The engines know a number by the plugin's name for it, not the word shown.
  const asked = list.map((w) => (w.toLowerCase() === 'latency' ? 'time' : w))
  const [hosts, services] = await Promise.all([
    api.query({ table: 'hosts', columns: ['name', 'perf_data'], headers: ['Filter: perf_data != ', ...each(asked, ['name', 'perf_data'])], sort: [{ column: 'name' }], limit: 20 }),
    api.query({ table: 'services', columns: ['host_name', 'description', 'perf_data'], headers: ['Filter: perf_data != ', ...each(asked, ['host_name', 'description', 'perf_data'])], sort: [{ column: 'host_name' }, { column: 'description' }], limit: 40 }),
  ])
  const rows = [
    ...hosts.rows.map((r) => ({ backend: r.backend, host: String(r.name), service: undefined as string | undefined, perf: String(r.perf_data) })),
    ...services.rows.map((r) => ({ backend: r.backend, host: String(r.host_name), service: String(r.description), perf: String(r.perf_data) })),
  ]
  for (const r of rows) {
    // A few of each, so that one check with many numbers leaves room for others.
    for (const p of parsePerfdata(r.perf).slice(0, 6)) {
      const text = [r.host, r.service, labelText(p.label)].filter(Boolean).join(' · ')
      if (!has(text, list)) continue
      out.push({
        key: `${r.backend}\n${text}`,
        text,
        detail: whose(r.backend, `${p.value}${p.unit}`),
        pick: () => emit('series', { backend: r.backend, host: r.host, ...(r.service ? { service: r.service } : {}), label: p.label }),
      })
      if (out.length >= 40) return out
    }
  }
  return out
}

async function look(): Promise<Found[]> {
  const list = words.value.trim().split(/\s+/).filter(Boolean).slice(0, 4)
  if (list.length > 0) return search(list)
  if (inside.value) return insideHost(inside.value)
  return browse()
}

watch(
  [words, inside],
  async () => {
    const mine = ++asked
    try {
      const result = await look()
      if (mine === asked) found.value = result
    } catch {
      if (mine === asked) found.value = []
    }
  },
  { immediate: true },
)
const first = computed(() => found.value.find((f) => f.pick))

function choose(f: Found) {
  if (f.pick) {
    f.pick()
    // The next number of a graph starts from the list again.
    if (props.mode === 'series') words.value = ''
  } else if (f.open) {
    words.value = ''
    inside.value = f.open
  }
}
function back() {
  inside.value = inside.value?.service !== undefined ? { backend: inside.value.backend, host: inside.value.host } : null
}
</script>

<template>
  <div class="find">
    <input
      ref="box"
      v-model="words"
      type="search"
      :aria-label="label ?? 'Find'"
      :placeholder="mode === 'series' ? 'Search numbers' : 'Search'"
      autocomplete="off"
      autocapitalize="none"
      @keydown.enter.prevent="first && choose(first)"
    />
    <ul v-if="found.length > 0 || inside" class="found">
      <li v-if="inside && !words.trim()">
        <button type="button" class="plain back" @click="back">‹ {{ inside.service ?? inside.host }}</button>
      </li>
      <li v-for="f in found" :key="f.key" :class="{ head: f.head }">
        <template v-if="f.head">{{ f.text }}</template>
        <div v-else class="row">
          <button type="button" class="plain" :disabled="!f.pick && !f.open" @click="choose(f)">
            {{ f.text }}<span v-if="f.detail" class="detail">{{ f.detail }}</span>
          </button>
          <button v-if="f.pick && f.open" type="button" class="plain into" :aria-label="`Inside ${f.text}`" @click="words = ''; inside = f.open">›</button>
          <span v-else-if="f.open" class="into" aria-hidden="true">›</span>
        </div>
      </li>
    </ul>
  </div>
</template>
