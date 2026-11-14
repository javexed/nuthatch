<script setup lang="ts">
// What fills up: the trend checks (checkd:trend) that see a limit
// coming, soonest first.
import { computed } from 'vue'
import { useLoader } from '../stores/live'
import { api } from '../stores/session'
import StateBadge from './StateBadge.vue'

const { data } = useLoader(() =>
  api.query({
    table: 'services',
    columns: ['host_name', 'description', 'state', 'plugin_output', 'perf_data'],
    headers: ['Filter: plugin_output ~ ^TREND (WARNING|CRITICAL) -'],
  }),
)
const rows = computed(() =>
  (data.value?.rows ?? [])
    .map((r) => ({ ...r, days: Number(/days_left=([0-9.]+)/.exec(String(r.perf_data))?.[1] ?? 0), text: String(r.plugin_output).replace(/^TREND \w+ - /, '') }))
    .sort((a, b) => a.days - b.days),
)
</script>

<template>
  <template v-if="rows.length > 0">
    <h2>Filling up</h2>
    <ul class="filling card">
      <li v-for="r in rows" :key="`${r.backend} ${r.host_name} ${r.description}`">
        <StateBadge kind="service" :state="r.state" />
        <RouterLink :to="{ name: 'service', params: { backend: r.backend, host: String(r.host_name), service: String(r.description) } }">
          {{ r.host_name }} / {{ r.description }}
        </RouterLink>
        <span class="by">{{ r.text }}</span>
      </li>
    </ul>
  </template>
</template>
