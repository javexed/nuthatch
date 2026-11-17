<script setup lang="ts">
// The services that take passive results, and when each was last told.
import { computed } from 'vue'
import StateBadge from '../components/StateBadge.vue'
import { ago } from '../lib/format'
import { useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'

const session = useSession()
const many = computed(() => (session.session?.backends.length ?? 0) > 1)
const { data, error } = useLoader(() => api.passive())
const rows = computed(() => data.value?.services ?? [])
</script>

<template>
  <h1>Passive</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-else-if="data && rows.length === 0" class="none">None</p>
  <table v-else-if="rows.length > 0" class="rows">
    <thead>
      <tr><th>Service</th><th>State</th><th>Last</th><th>Output</th></tr>
    </thead>
    <tbody>
      <tr v-for="r in rows" :key="`${r.backend} ${r.host} ${r.service}`">
        <td>
          <RouterLink :to="{ name: 'service', params: { backend: r.backend, host: r.host, service: r.service } }">{{ r.host }} / {{ r.service }}</RouterLink>
          <span v-if="many" class="backend">{{ r.backend }}</span>
        </td>
        <td><StateBadge kind="service" :state="r.state" :checked="r.last > 0 ? 1 : 0" /></td>
        <td>{{ r.last ? ago(r.last) : 'never' }}</td>
        <td class="output">{{ r.output }}</td>
      </tr>
    </tbody>
  </table>
</template>
