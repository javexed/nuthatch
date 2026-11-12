<script setup lang="ts">
// The state of everything at a glance: how many hosts and services are
// in each state and how many of the problems nobody has taken care of,
// and how the backends are.
import { computed } from 'vue'
import { states } from '../lib/states'
import { useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'

const session = useSession()

/** Per state: all, and those not acknowledged and not in a downtime. */
function counting(kind: 'host' | 'service'): string[] {
  const unhandled = ['Stats: acknowledged = 0', 'Stats: scheduled_downtime_depth = 0']
  if (kind === 'service') unhandled.push('Stats: host_acknowledged = 0', 'Stats: host_scheduled_downtime_depth = 0')
  return states(kind).flatMap((_, state) => [
    `Stats: state = ${state}`,
    'Stats: has_been_checked = 1',
    'StatsAnd: 2',
    `Stats: state = ${state}`,
    'Stats: has_been_checked = 1',
    ...unhandled,
    `StatsAnd: ${unhandled.length + 2}`,
  ]).concat('Stats: has_been_checked = 0')
}

const { data, error } = useLoader(async () => {
  const [hosts, services] = await Promise.all([
    api.stats({ table: 'hosts', headers: counting('host') }),
    api.stats({ table: 'services', headers: counting('service') }),
  ])
  return { hosts: hosts.groups[0]?.values ?? [], services: services.groups[0]?.values ?? [], errors: { ...hosts.errors, ...services.errors } }
})

function tiles(kind: 'host' | 'service') {
  const values = (kind === 'host' ? data.value?.hosts : data.value?.services) ?? []
  const list = states(kind).map((state, n) => ({ ...state, n, all: values[2 * n] ?? 0, unhandled: values[2 * n + 1] ?? 0 }))
  return { list, pending: values[2 * states(kind).length] ?? 0 }
}
const hosts = computed(() => tiles('host'))
const services = computed(() => tiles('service'))
const backends = computed(() => session.session?.backends ?? [])
</script>

<template>
  <h1>Overview</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <section v-for="group in [{ title: 'Hosts', route: 'hosts', tiles: hosts }, { title: 'Services', route: 'services', tiles: services }]" :key="group.title" class="card" :aria-label="group.title">
    <h2>{{ group.title }}</h2>
    <ul class="totals">
      <li v-for="tile in group.tiles.list" :key="tile.label" :class="['tile', tile.tone, { none: tile.all === 0 }]">
        <RouterLink :to="{ name: group.route, query: { state: String(tile.n) } }"><strong>{{ tile.all }}</strong> {{ tile.label }}</RouterLink>
        <RouterLink v-if="tile.n > 0 && tile.unhandled > 0" class="unhandled" :to="{ name: group.route, query: { state: String(tile.n), unhandled: '1' } }">
          {{ tile.unhandled }} unhandled
        </RouterLink>
      </li>
      <li v-if="group.tiles.pending > 0" class="tile pending"><span><strong>{{ group.tiles.pending }}</strong> Pending</span></li>
    </ul>
  </section>
  <section class="card" aria-label="Backends">
    <h2>Backends</h2>
    <ul class="backends">
      <li v-for="backend in backends" :key="backend.name">
        <strong>{{ backend.name }}</strong>
        <span v-if="data?.errors[backend.name]" class="error">{{ data.errors[backend.name] }}</span>
        <span v-else-if="backend.ok">answering<template v-if="backend.program_version"> · {{ backend.program_version }}</template></span>
        <span v-else class="error">{{ backend.error ?? 'not answering' }}</span>
      </li>
    </ul>
  </section>
</template>
