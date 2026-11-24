<script setup lang="ts">
// The dashboards there are: one's own, and those shared with everyone.
// Everyone has an Overview from the start; a new one is made whole in one
// click, from a template, or from a file. Several can take turns on a wall.
import type { CheckNumber, DashboardDraft, Subject } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import FindTarget from '../components/FindTarget.vue'
import { hostGroups } from '../lib/choices'
import { parsePerfdata } from '../lib/perfdata'
import { blank, forSubject, overview } from '../lib/templates'
import { api, useSession } from '../stores/session'

const session = useSession()
const router = useRouter()
const list = ref<Awaited<ReturnType<typeof api.dashboards>> | null>(null)
const problem = ref('')
const making = ref(false)
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
/** One subject, and panels that follow it: graphs of the numbers it has
 * most, the first of each check. */
async function makeFor(subject: Subject) {
  const headers =
    subject.kind === 'host'
      ? [`Filter: host_name = ${clean(subject.host)}`]
      : subject.kind === 'hostgroup'
        ? [`Filter: host_groups >= ${clean(subject.name)}`]
        : subject.kind === 'servicegroup'
          ? [`Filter: groups >= ${clean(subject.name)}`]
          : subject.hostgroup
            ? [`Filter: host_groups >= ${clean(subject.hostgroup)}`]
            : []
  const services = await api.query({ table: 'services', columns: ['description', 'perf_data'], headers: [...headers, 'Filter: perf_data != '], limit: 2000, ...(subject.kind === 'host' ? { backends: [subject.backend] } : {}) })
  const count = new Map<string, { n: CheckNumber; times: number }>()
  for (const r of services.rows) {
    const first = parsePerfdata(String(r.perf_data))[0]
    if (!first) continue
    // A service group's services are one number whatever their names.
    const n: CheckNumber = subject.kind === 'servicegroup' ? { label: first.label } : { service: String(r.description), label: first.label }
    const key = `${n.service ?? ''}\n${n.label}`
    count.set(key, { n, times: (count.get(key)?.times ?? 0) + 1 })
  }
  const numbers = [...count.values()].sort((a, b) => b.times - a.times || (a.n.service ?? '').localeCompare(b.n.service ?? '')).map((c) => c.n)
  await make(forSubject(subject, numbers))
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
    <button type="button" class="template" :disabled="busy" :aria-pressed="making" @click="making = !making">For a host or group</button>
    <button type="button" class="template" :disabled="busy" @click="make(blank('New dashboard'))">Blank</button>
    <label class="template">Import <input type="file" accept="application/json,.json" class="file" @change="importFile" /></label>
  </div>
  <div v-if="making" class="card">
    <FindTarget mode="subject" label="Host or group" focus @subject="makeFor" />
  </div>
</template>
