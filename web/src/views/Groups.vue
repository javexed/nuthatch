<script setup lang="ts">
// Host groups or service groups, each with how its members are doing.
import { computed } from 'vue'
import { useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'

const props = defineProps<{ kind: 'host' | 'service' }>()
const session = useSession()
const many = computed(() => (session.session?.backends.length ?? 0) > 1)
const canAdd = computed(() => session.has('config_edit') && (session.session?.config_backends ?? []).length > 0)

const HOSTS = ['num_hosts_up', 'num_hosts_down', 'num_hosts_unreach', 'num_hosts_pending'] as const
const SERVICES = ['num_services_ok', 'num_services_warn', 'num_services_crit', 'num_services_unknown', 'num_services_pending'] as const

const { data, error, loading } = useLoader(
  () =>
    api.query({
      table: props.kind === 'host' ? 'hostgroups' : 'servicegroups',
      columns: ['name', 'alias', ...(props.kind === 'host' ? HOSTS : []), ...SERVICES],
      sort: [{ column: 'name' }],
    }),
  [() => props.kind],
)
const rows = computed(() => (data.value?.rows ?? []) as (Record<string, unknown> & { backend: string })[])
const errors = computed(() => Object.entries(data.value?.errors ?? {}))

const hostTones = ['ok', 'critical', 'unknown', 'pending']
const serviceTones = ['ok', 'warning', 'critical', 'unknown', 'pending']
const hostNames = ['up', 'down', 'unreachable', 'pending']
const serviceNames = ['OK', 'warning', 'critical', 'unknown', 'pending']

function hostsLink(row: Record<string, unknown>, state?: number) {
  return { name: 'hosts', query: { group: String(row.name), ...(state === undefined ? {} : { state: String(state) }) } }
}

function servicesLink(row: Record<string, unknown>, state?: number) {
  const narrowed = props.kind === 'host' ? { hostgroup: String(row.name) } : { group: String(row.name) }
  return { name: 'services', query: { ...narrowed, ...(state === undefined ? {} : { state: String(state) }) } }
}
</script>

<template>
  <div class="page-head">
    <h1>{{ kind === 'host' ? 'Host groups' : 'Service groups' }}</h1>
    <RouterLink v-if="canAdd" class="button" :to="{ name: 'config', query: { new: kind === 'host' ? 'hostgroup' : 'servicegroup' } }">
      New {{ kind === 'host' ? 'host group' : 'service group' }}
    </RouterLink>
  </div>
  <nav class="tabs" aria-label="Kinds of group">
    <RouterLink :to="{ name: 'hostgroups' }">Host groups</RouterLink>
    <RouterLink :to="{ name: 'servicegroups' }">Service groups</RouterLink>
  </nav>
  <p v-for="[name, why] in errors" :key="name" class="error" role="alert"><strong>{{ name }}</strong>: {{ why }}</p>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="!loading && !error && rows.length === 0" class="none">None</p>
  <ul class="groups">
    <li v-for="row in rows" :key="`${row.backend} ${row.name}`" class="card">
      <h2>
        <RouterLink :to="kind === 'host' ? hostsLink(row) : servicesLink(row)">{{ row.alias || row.name }}</RouterLink>
        <span v-if="many" class="backend">{{ row.backend }}</span>
      </h2>
      <p v-if="kind === 'host'" class="counts">
        <span class="what">Hosts</span>
        <template v-for="(column, n) in HOSTS" :key="column">
          <RouterLink v-if="Number(row[column]) > 0" :to="hostsLink(row, n < 3 ? n : undefined)" :class="['badge', hostTones[n]]">
            {{ row[column] }} {{ hostNames[n] }}
          </RouterLink>
        </template>
      </p>
      <p class="counts">
        <span class="what">Services</span>
        <template v-for="(column, n) in SERVICES" :key="column">
          <RouterLink v-if="Number(row[column]) > 0" :to="servicesLink(row, n < 4 ? n : undefined)" :class="['badge', serviceTones[n]]">
            {{ row[column] }} {{ serviceNames[n] }}
          </RouterLink>
        </template>
      </p>
    </li>
  </ul>
</template>
