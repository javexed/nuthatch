<script setup lang="ts">
// A host or service, or one of its numbers, as a panel on a dashboard.
import type { Dashboard, PanelSettings } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, ref } from 'vue'
import { SIZES, withPanel } from '../lib/layout'
import { api, useSession } from '../stores/session'

const props = defineProps<{ backend: string; host: string; service?: string; labels: string[] }>()
const session = useSession()

const open = ref(false)
const boards = ref<Dashboard[]>([])
const board = ref<number | 'new'>('new')
const title = ref('')
const kind = ref<'object' | 'stat' | 'graph'>('object')
const label = ref('')
const busy = ref(false)
const error = ref('')
const added = ref<Dashboard | null>(null)

async function start() {
  open.value = true
  added.value = null
  error.value = ''
  label.value = props.labels[0] ?? ''
  try {
    const user = session.session?.user
    boards.value = (await api.dashboards()).filter((d) => d.owner === user || d.shared)
    board.value = boards.value[0]?.id ?? 'new'
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
}

const panel = computed<PanelSettings>(() => {
  const at = { backend: props.backend, host: props.host, ...(props.service !== undefined ? { service: props.service } : {}) }
  if (kind.value === 'object') return { type: 'object', ...at }
  return { type: kind.value, ...at, ...(label.value ? { label: label.value } : {}), ...(kind.value === 'graph' ? { hours: 24 } : {}) }
})

async function add() {
  busy.value = true
  error.value = ''
  try {
    const [w, h] = SIZES[kind.value]
    if (board.value === 'new') {
      added.value = await api.newDashboard({ title: title.value.trim(), shared: false, widgets: [{ ...panel.value, layout: { x: 0, y: 0, w, h } }] })
    } else {
      const d = await api.dashboard(board.value)
      added.value = await api.saveDashboard(d.id, { title: d.title, shared: d.shared, widgets: withPanel(d.widgets, panel.value) })
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <button v-if="!open" type="button" class="quiet" @click="start">Add to dashboard</button>
  <form v-else class="card add-to-dash" aria-label="Add to dashboard" @submit.prevent="add">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label class="field">
      Dashboard
      <select v-model="board" name="dashboard">
        <option v-for="d in boards" :key="d.id" :value="d.id">{{ d.title }}</option>
        <option value="new">New…</option>
      </select>
    </label>
    <label v-if="board === 'new'" class="field">Title <input v-model="title" name="dashboard-title" required maxlength="200" /></label>
    <fieldset class="field kinds">
      <legend>Panel</legend>
      <label><input v-model="kind" type="radio" value="object" /> Status</label>
      <template v-if="labels.length > 0">
        <label><input v-model="kind" type="radio" value="stat" /> Number</label>
        <label><input v-model="kind" type="radio" value="graph" /> Graph</label>
      </template>
    </fieldset>
    <label v-if="kind !== 'object' && labels.length > 1" class="field">
      Metric
      <select v-model="label" name="label">
        <option v-for="l in labels" :key="l" :value="l">{{ l }}</option>
      </select>
    </label>
    <div class="row">
      <button type="submit" :disabled="busy">Add</button>
      <button type="button" class="quiet" @click="open = false">Close</button>
      <RouterLink v-if="added" :to="{ name: 'dashboard', params: { id: added.id } }" role="status">Added · open</RouterLink>
    </div>
  </form>
</template>

<style scoped>
.add-to-dash {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem 1rem;
  align-items: end;
}
.kinds {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  gap: 0.75rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
</style>
