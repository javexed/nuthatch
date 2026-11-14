<script setup lang="ts">
// The dashboards there are: one's own, and those shared with everyone.
// Everyone has an Overview from the start; a new one is made whole in one
// click, from a template, or from a file. Several can take turns on a wall.
import type { DashboardDraft, Scope, Series } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import FindTarget from '../components/FindTarget.vue'
import { hostGroups } from '../lib/choices'
import { parsePerfdata } from '../lib/perfdata'
import { blank, forGroup, forHost, overview } from '../lib/templates'
import { api, useSession } from '../stores/session'

const session = useSession()
const router = useRouter()
const list = ref<Awaited<ReturnType<typeof api.dashboards>> | null>(null)
const problem = ref('')
const making = ref<'' | 'group' | 'host'>('')
const groups = ref<string[]>([])
const busy = ref(false)
const clean = (t: string) => t.replace(/[\r\n]/g, ' ')

async function load() {
  try {
    list.value = await api.dashboards()
    const user = session.session?.user
    // Everyone has an Overview from the start, once.
    if (!list.value.some((d) => d.owner === user) && !(await api.pref<boolean>('overview_made').catch(() => true))) {
      await api.setPref('overview_made', true)
      await api.newDashboard(overview(await hostGroups().catch(() => [])))
      list.value = await api.dashboards()
    }
  } catch (err) {
    problem.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
}
onMounted(load)

async function make(draft: DashboardDraft, query: Record<string, string> = {}) {
  busy.value = true
  problem.value = ''
  try {
    const made = await api.newDashboard(draft)
    await router.push({ name: 'dashboard', params: { id: made.id }, query })
  } catch (err) {
    problem.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    busy.value = false
  }
}

async function makeOverview() {
  await make(overview(await hostGroups().catch(() => [])))
}
async function startGroup() {
  making.value = 'group'
  groups.value = await hostGroups().catch(() => [])
}
/** A host group: a number of each host's own check, where it has one. */
async function makeGroup(group: string) {
  const hosts = await api.query({ table: 'hosts', columns: ['name', 'perf_data'], headers: [`Filter: groups >= ${clean(group)}`, 'Filter: perf_data != '], sort: [{ column: 'name' }], limit: 12 })
  const numbers: Series[] = hosts.rows.flatMap((r) => {
    const first = parsePerfdata(String(r.perf_data))[0]
    return first ? [{ backend: r.backend, host: String(r.name), label: first.label }] : []
  })
  await make(forGroup(group, numbers))
}
/** One host, chosen at the top: a graph of the first number of each of its services. */
async function makeHost(scope: Scope) {
  const of = scope.of
  if (!of || of.host === '$host') return
  const services = await api.query({ table: 'services', columns: ['description', 'perf_data'], headers: [`Filter: host_name = ${clean(of.host)}`, 'Filter: perf_data != '], sort: [{ column: 'description' }], backends: [of.backend], limit: 8 })
  const metrics: Series[] = services.rows.flatMap((r) => {
    const first = parsePerfdata(String(r.perf_data))[0]
    return first ? [{ backend: of.backend, host: of.host, service: String(r.description), label: first.label }] : []
  })
  await make(forHost(metrics), { host: of.host, backend: of.backend })
}

/** A dashboard from a file another nuthatch exported. */
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const given = JSON.parse(await file.text()) as Partial<DashboardDraft>
    await make({ ...given, shared: false } as DashboardDraft)
  } catch (err) {
    problem.value = err instanceof ApiError ? err.message : 'Not a dashboard file'
  }
}

// Several dashboards taking turns on a wall.
const onWall = ref<number[]>([])
const every = ref(30)
const wallable = computed(() => onWall.value.length > 0)
function startWall() {
  const ids = onWall.value
  const query: Record<string, string> = { wall: '1', ...(ids.length > 1 ? { rotate: ids.join(','), every: String(every.value) } : {}) }
  void router.push({ name: 'dashboard', params: { id: ids[0] }, query })
}
</script>

<template>
  <h1>Dashboards</h1>
  <p v-if="problem" class="error" role="alert">{{ problem }}</p>
  <ul v-if="list && list.length > 0" class="managed">
    <li v-for="dashboard in list" :key="dashboard.id" class="card">
      <label class="wall-pick"><input v-model="onWall" type="checkbox" :value="dashboard.id" :aria-label="`${dashboard.title} on a wall`" /></label>
      <div>
        <RouterLink :to="{ name: 'dashboard', params: { id: dashboard.id } }"><strong>{{ dashboard.title }}</strong></RouterLink>
        <span class="by">
          <template v-if="dashboard.owner !== session.session?.user">by {{ dashboard.owner }}</template>
          <template v-else-if="dashboard.shared">shared</template>
        </span>
      </div>
    </li>
  </ul>
  <p v-else-if="list" class="none">None</p>
  <div v-if="wallable" class="row wall-start">
    <label class="field">Every <input v-model.number="every" type="number" min="5" max="3600" class="seconds" /> s</label>
    <button type="button" @click="startWall">Wall</button>
  </div>

  <h2>New</h2>
  <div class="templates">
    <button type="button" class="template" :disabled="busy" @click="makeOverview">Overview</button>
    <button type="button" class="template" :disabled="busy" @click="startGroup">For a host group</button>
    <button type="button" class="template" :disabled="busy" @click="making = 'host'">For a host</button>
    <button type="button" class="template" :disabled="busy" @click="make(blank('New dashboard'))">Blank</button>
    <label class="template">Import <input type="file" accept="application/json,.json" class="file" @change="importFile" /></label>
  </div>
  <div v-if="making === 'group'" class="card">
    <p v-if="groups.length === 0" class="none">None</p>
    <button v-for="g in groups" :key="g" type="button" class="quiet" :disabled="busy" @click="makeGroup(g)">{{ g }}</button>
  </div>
  <div v-if="making === 'host'" class="card">
    <FindTarget mode="scope" label="Host" @scope="makeHost" />
  </div>
</template>
