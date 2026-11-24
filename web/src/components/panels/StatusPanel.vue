<script setup lang="ts">
// One service: its card. One host: its card and a tile per service. A
// host group, or everything: how many hosts are in each state, and a tile
// per host, marked when one of its services is not OK. A service group:
// how many services are in each state, and a tile per service.
import type { Scope } from '@nuthatch/api'
import { computed, watch } from 'vue'
import { stateOf } from '../../lib/states'
import { useLoader } from '../../stores/live'
import { api } from '../../stores/session'
import ObjectCard from '../ObjectCard.vue'

const props = defineProps<{ scope: Scope }>()
const emit = defineEmits<{ worst: [state: number] }>()
const clean = (text: string) => text.replace(/[\r\n]/g, ' ')

interface Tile {
  key: string
  name: string
  tone: string
  /** A service of the host is not OK: its worst state's tone. */
  mark?: string
  to: object
}

const { data } = useLoader(
  async (): Promise<{ tiles: Tile[]; worst: number }> => {
    const of = props.scope.of
    if (of?.service) {
      const rows = (await api.query({ table: 'services', columns: ['state', 'has_been_checked'], headers: [`Filter: host_name = ${clean(of.host)}`, `Filter: description = ${clean(of.service)}`], backends: [of.backend] })).rows
      return { tiles: [], worst: Number(rows[0]?.state ?? 0) }
    }
    if (of) {
      const [host, services] = await Promise.all([
        api.query({ table: 'hosts', columns: ['state'], headers: [`Filter: name = ${clean(of.host)}`], backends: [of.backend] }),
        api.query({ table: 'services', columns: ['description', 'state', 'has_been_checked'], headers: [`Filter: host_name = ${clean(of.host)}`], sort: [{ column: 'description' }], backends: [of.backend] }),
      ])
      const tiles = services.rows.map((r) => ({
        key: String(r.description),
        name: String(r.description),
        tone: stateOf('service', r.state, r.has_been_checked).tone,
        to: { name: 'service', params: { backend: of.backend, host: of.host, service: String(r.description) } },
      }))
      const hostDown = Number(host.rows[0]?.state ?? 0) > 0 ? 2 : 0
      return { tiles, worst: Math.max(hostDown, ...services.rows.map((r) => Number(r.state ?? 0))) }
    }
    if (props.scope.servicegroup) {
      const services = (
        await api.query({
          table: 'services',
          columns: ['host_name', 'description', 'state', 'has_been_checked'],
          headers: [`Filter: groups >= ${clean(props.scope.servicegroup)}`],
          sort: [{ column: 'host_name' }, { column: 'description' }],
          limit: 500,
        })
      ).rows
      const tiles = services.map((r) => ({
        key: `${r.backend}\n${String(r.host_name)}\n${String(r.description)}`,
        name: `${String(r.host_name)} · ${String(r.description)}`,
        tone: stateOf('service', r.state, r.has_been_checked).tone,
        to: { name: 'service', params: { backend: r.backend, host: String(r.host_name), service: String(r.description) } },
      }))
      return { tiles, worst: Math.max(0, ...services.map((r) => Number(r.state ?? 0))) }
    }
    const rows = (
      await api.query({
        table: 'hosts',
        columns: ['name', 'state', 'has_been_checked', 'worst_service_state'],
        headers: props.scope.hostgroup ? [`Filter: groups >= ${clean(props.scope.hostgroup)}`] : [],
        sort: [{ column: 'name' }],
        limit: 500,
      })
    ).rows
    const tiles = rows.map((r) => ({
      key: `${r.backend}\n${String(r.name)}`,
      name: String(r.name),
      tone: stateOf('host', r.state, r.has_been_checked).tone,
      ...(Number(r.worst_service_state) > 0 ? { mark: stateOf('service', r.worst_service_state).tone } : {}),
      to: { name: 'host', params: { backend: r.backend, host: String(r.name) } },
    }))
    const worst = Math.max(0, ...rows.map((r) => Math.max(Number(r.state) > 0 ? 2 : 0, Number(r.worst_service_state ?? 0))))
    return { tiles, worst }
  },
  [() => JSON.stringify(props.scope)],
)
watch(() => data.value?.worst, (worst) => emit('worst', worst ?? 0), { immediate: true })

const counts = computed(() => {
  if (props.scope.of) return []
  const by = new Map<string, number>()
  for (const t of data.value?.tiles ?? []) by.set(t.tone, (by.get(t.tone) ?? 0) + 1)
  const LABEL: Record<string, string> = props.scope.servicegroup ? { ok: 'OK', warning: 'warning', critical: 'critical', unknown: 'unknown', pending: 'pending' } : { ok: 'up', critical: 'down', unknown: 'unreachable', pending: 'pending' }
  return [...by.entries()].map(([tone, n]) => ({ tone, text: `${n} ${LABEL[tone] ?? tone}` }))
})
</script>

<template>
  <ObjectCard v-if="scope.of" :backend="scope.of.backend" :host="scope.of.host" :service="scope.of.service" />
  <p v-if="counts.length > 0" class="counts">
    <span v-for="c in counts" :key="c.tone" :class="['count', c.tone]">{{ c.text }}</span>
  </p>
  <ul v-if="data && data.tiles.length > 0" class="status-tiles">
    <li v-for="t in data.tiles" :key="t.key" :class="['status-tile', t.tone]">
      <RouterLink :to="t.to" :title="t.name">{{ t.name }}<span v-if="t.mark" :class="['mark-dot', t.mark]" aria-label="a service is not OK"></span></RouterLink>
    </li>
  </ul>
  <p v-else-if="data && !scope.of" class="none">None</p>
</template>
