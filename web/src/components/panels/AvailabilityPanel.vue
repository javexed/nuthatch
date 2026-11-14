<script setup lang="ts">
// The share of the range a host or service was up or OK; for a host group
// or everything, of all its hosts together, and the lowest of them.
import type { Scope } from '@nuthatch/api'
import { computed } from 'vue'
import { type Availability, availability, percent, showPercent } from '../../lib/availability'
import { useLoader } from '../../stores/live'
import { api } from '../../stores/session'

const props = defineProps<{ scope: Scope; seconds: number; rows: number }>()
const clean = (text: string) => text.replace(/[\r\n]/g, ' ')

const { data } = useLoader(
  async (): Promise<Availability[]> => {
    const to = Date.now() / 1000
    const span = { from: to - props.seconds, to }
    const of = props.scope.of
    if (of?.service) {
      const answer = await availability(api, 'service', span, { host: of.host, backends: [of.backend] })
      return answer.rows.filter((r) => r.service === of.service)
    }
    if (of) return (await availability(api, 'host', span, { host: of.host, backends: [of.backend] })).rows
    const all = (await availability(api, 'host', span)).rows
    if (!props.scope.hostgroup) return all
    const members = await api.query({ table: 'hosts', columns: ['name'], headers: [`Filter: groups >= ${clean(props.scope.hostgroup)}`] })
    const wanted = new Set(members.rows.map((r) => `${r.backend}\n${String(r.name)}`))
    return all.filter((r) => wanted.has(`${r.backend}\n${r.host}`))
  },
  [() => JSON.stringify(props.scope), () => props.seconds],
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
    <p class="by">{{ scope.of?.service ? 'OK' : 'up' }}</p>
    <ul v-if="lowest.length > 0" class="lowest">
      <li v-for="r in lowest" :key="`${r.backend}\n${r.host}`">
        <RouterLink :to="{ name: 'host', params: { backend: r.backend, host: r.host } }">{{ r.host }}</RouterLink>
        <span>{{ showPercent(percent(r, 0)) }}</span>
      </li>
    </ul>
  </div>
</template>
