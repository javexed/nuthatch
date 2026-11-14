<script setup lang="ts">
// One search for what a panel shows: a few words, and every host group,
// host, service or metric whose names have them all. Nothing to know of
// backends or exact names.
import type { Scope, Series } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { literal } from '../lib/filters'
import { parsePerfdata } from '../lib/perfdata'
import { api, useSession } from '../stores/session'

const props = defineProps<{ mode: 'scope' | 'series'; chooser?: boolean; label?: string }>()
const emit = defineEmits<{ scope: [scope: Scope]; series: [series: Series] }>()

interface Found {
  key: string
  text: string
  detail?: string
  pick: () => void
}

const session = useSession()
/** With more than one backend, each result says whose it is. */
const whose = (backend: string, detail?: string) => ((session.session?.backends.length ?? 0) > 1 ? [detail, backend].filter(Boolean).join(' · ') : detail)
const words = ref('')
const found = ref<Found[]>([])
let asked = 0

const clean = (w: string) => literal(w.replace(/[\r\n]/g, ' '))
/** Every word in one of these columns. */
const each = (list: string[], columns: string[]) => list.flatMap((w) => [...columns.map((c) => `Filter: ${c} ~~ ${clean(w)}`), ...(columns.length > 1 ? [`Or: ${columns.length}`] : [])])
const has = (text: string, list: string[]) => list.every((w) => text.toLowerCase().includes(w.toLowerCase()))

async function look(text: string): Promise<Found[]> {
  const list = text.trim().split(/\s+/).filter(Boolean).slice(0, 4)
  const out: Found[] = []
  if (props.mode === 'scope') {
    if (props.chooser && (list.length === 0 || has('chosen host', list))) out.push({ key: '$host', text: 'The chosen host', pick: () => emit('scope', { of: { backend: '$host', host: '$host' } }) })
    if (list.length === 0) {
      out.push({ key: 'all', text: 'All hosts', pick: () => emit('scope', {}) })
      return out
    }
    if (has('all hosts', list)) out.push({ key: 'all', text: 'All hosts', pick: () => emit('scope', {}) })
    const [groups, hosts, services] = await Promise.all([
      api.query({ table: 'hostgroups', columns: ['name'], headers: each(list, ['name', 'alias']), limit: 8 }),
      api.query({ table: 'hosts', columns: ['name'], headers: each(list, ['name', 'alias', 'address']), sort: [{ column: 'name' }], limit: 10 }),
      api.query({ table: 'services', columns: ['host_name', 'description'], headers: each(list, ['host_name', 'description']), sort: [{ column: 'host_name' }], limit: 15 }),
    ])
    for (const g of new Set(groups.rows.map((r) => String(r.name)))) out.push({ key: `g\n${g}`, text: g, detail: 'host group', pick: () => emit('scope', { hostgroup: g }) })
    for (const r of hosts.rows) {
      const host = String(r.name)
      out.push({ key: `h\n${r.backend}\n${host}`, text: host, detail: whose(r.backend, 'host'), pick: () => emit('scope', { of: { backend: r.backend, host } }) })
    }
    for (const r of services.rows) {
      const host = String(r.host_name)
      const service = String(r.description)
      out.push({ key: `s\n${r.backend}\n${host}\n${service}`, text: `${host} · ${service}`, detail: whose(r.backend), pick: () => emit('scope', { of: { backend: r.backend, host, service } }) })
    }
    return out
  }
  if (list.length === 0) return out
  const [hosts, services] = await Promise.all([
    api.query({ table: 'hosts', columns: ['name', 'perf_data'], headers: ['Filter: perf_data != ', ...each(list, ['name', 'perf_data'])], limit: 10 }),
    api.query({ table: 'services', columns: ['host_name', 'description', 'perf_data'], headers: ['Filter: perf_data != ', ...each(list, ['host_name', 'description', 'perf_data'])], limit: 25 }),
  ])
  const rows = [
    ...hosts.rows.map((r) => ({ backend: r.backend, host: String(r.name), service: undefined as string | undefined, perf: String(r.perf_data) })),
    ...services.rows.map((r) => ({ backend: r.backend, host: String(r.host_name), service: String(r.description), perf: String(r.perf_data) })),
  ]
  for (const r of rows) {
    for (const p of parsePerfdata(r.perf)) {
      const text = [r.host, r.service, p.label].filter(Boolean).join(' · ')
      if (!has(text, list)) continue
      out.push({
        key: `${r.backend}\n${text}`,
        text,
        detail: whose(r.backend, `${p.value}${p.unit}`),
        pick: () => emit('series', { backend: r.backend, host: r.host, ...(r.service ? { service: r.service } : {}), label: p.label }),
      })
      if (out.length >= 30) return out
    }
  }
  return out
}

watch(
  words,
  async (text) => {
    const mine = ++asked
    try {
      const result = await look(text)
      if (mine === asked) found.value = result
    } catch {
      if (mine === asked) found.value = []
    }
  },
  { immediate: true },
)
const first = computed(() => found.value[0])
</script>

<template>
  <div class="find">
    <input v-model="words" type="search" :aria-label="label ?? 'Find'" :placeholder="mode === 'series' ? 'host service metric' : 'host, service or group'" autocomplete="off" autocapitalize="none" @keydown.enter.prevent="first?.pick()" />
    <ul v-if="found.length > 0" class="found">
      <li v-for="f in found" :key="f.key">
        <button type="button" class="plain" @click="f.pick()">
          {{ f.text }}<span v-if="f.detail" class="detail">{{ f.detail }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
