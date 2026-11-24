<script setup lang="ts">
// The share of the range a host or service was up or OK; for a host group
// or everything, of all its hosts together, and the lowest of them; for a
// service group, of its services.
import type { Scope } from '@nuthatch/api'
import { computed } from 'vue'
import { type Availability, availability, percent, showPercent } from '../../lib/availability'
import { type When, spanNow } from '../../lib/range'
import { useLoader } from '../../stores/live'
import { api } from '../../stores/session'

const props = defineProps<{ scope: Scope; when: When; rows: number }>()
const clean = (text: string) => text.replace(/[\r\n]/g, ' ')

const { data } = useLoader(
  async (): Promise<Availability[]> => {
    const { from, to } = spanNow(props.when)
    const span = { from, to }
    const of = props.scope.of
    if (of?.service) {
      const answer = await availability(api, 'service', span, { host: of.host, backends: [of.backend] })
      return answer.rows.filter((r) => r.service === of.service)
    }
    if (of) return (await availability(api, 'host', span, { host: of.host, backends: [of.backend] })).rows
    if (props.scope.servicegroup) {
      const [all, members] = await Promise.all([
        availability(api, 'service', span),
        api.query({ table: 'services', columns: ['host_name', 'description'], headers: [`Filter: groups >= ${clean(props.scope.servicegroup)}`] }),
      ])
      const wanted = new Set(members.rows.map((r) => `${r.backend}\n${String(r.host_name)}\n${String(r.description)}`))
      return all.rows.filter((r) => wanted.has(`${r.backend}\n${r.host}\n${r.service}`))
    }
    const all = (await availability(api, 'host', span)).rows
    if (!props.scope.hostgroup) return all
    const members = await api.query({ table: 'hosts', columns: ['name'], headers: [`Filter: groups >= ${clean(props.scope.hostgroup)}`] })
    const wanted = new Set(members.rows.map((r) => `${r.backend}\n${String(r.name)}`))
    return all.filter((r) => wanted.has(`${r.backend}\n${r.host}`))
  },
  [() => JSON.stringify(props.scope), () => JSON.stringify(props.when)],
  { live: false },
)

const overall = computed(() => {
  const rows = data.value ?? []
  const sum: Availability = { backend: '', host: '', service: '', seconds: [0, 0, 0, 0], unmonitored: 0 }
  for (const r of rows) r.seconds.forEach((s, n) => (sum.seconds[n as 0] += s))
  return percent(sum, 0)
})
const lowest = computed(() => (props.scope.of ? [] : (data.value ?? []).slice(0, Math.max(0, props.rows - 2))))
</script>

<template>
  <div class="availability-panel">
    <p class="value">{{ data ? showPercent(overall) : '–' }}</p>
    <p class="by">{{ scope.of?.service || scope.servicegroup ? 'OK' : 'up' }}</p>
    <ul v-if="lowest.length > 0" class="lowest">
      <li v-for="r in lowest" :key="`${r.backend}\n${r.host}\n${r.service}`">
        <RouterLink v-if="r.service" :to="{ name: 'service', params: { backend: r.backend, host: r.host, service: r.service } }">{{ r.host }} · {{ r.service }}</RouterLink>
        <RouterLink v-else :to="{ name: 'host', params: { backend: r.backend, host: r.host } }">{{ r.host }}</RouterLink>
        <span>{{ showPercent(percent(r, 0)) }}</span>
      </li>
    </ul>
  </div>
</template>
