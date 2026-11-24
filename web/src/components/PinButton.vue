<script setup lang="ts">
// A panel onto a dashboard with one click: the one pinned to last, or the
// one changed last, or a new one. Undo, or change where it went.
import type { Dashboard, PanelSettings } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { ref } from 'vue'
import { withPanel } from '../lib/layout'
import { blank } from '../lib/templates'
import { api, useSession } from '../stores/session'

const props = defineProps<{ panel: PanelSettings; label?: string }>()
const session = useSession()

const pinned = ref<Dashboard | null>(null)
let before: Dashboard | null = null
const choosing = ref(false)
const boards = ref<Dashboard[]>([])
const error = ref('')

async function editable(): Promise<Dashboard[]> {
  const user = session.session?.user
  return (await api.dashboards()).filter((d) => d.owner === user || d.shared).sort((a, b) => b.updated - a.updated)
}

async function pinTo(target: Dashboard | 'new') {
  const d = target === 'new' ? await api.newDashboard(blank('Pinned')) : target
  before = target === 'new' ? null : d
  pinned.value = await api.saveDashboard(d.id, { title: d.title, shared: d.shared, range: d.range, ...(d.subjects ? { subjects: d.subjects } : {}), widgets: withPanel(d.widgets, props.panel) })
  await api.setPref('pin_to', d.id).catch(() => undefined)
}

async function pin() {
  error.value = ''
  try {
    boards.value = await editable()
    const last = await api.pref<number>('pin_to').catch(() => null)
    await pinTo(boards.value.find((d) => d.id === last) ?? boards.value[0] ?? 'new')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
}

/** Takes the panel off again: the dashboard as it was, or the new one gone. */
async function undo() {
  const d = pinned.value
  if (!d) return
  if (before) await api.saveDashboard(d.id, { title: before.title, shared: before.shared, range: before.range, ...(before.subjects ? { subjects: before.subjects } : {}), widgets: before.widgets })
  else await api.deleteDashboard(d.id)
  pinned.value = null
}

async function change(value: string) {
  choosing.value = false
  await undo()
  boards.value = await editable()
  await pinTo(value === 'new' ? 'new' : (boards.value.find((d) => String(d.id) === value) ?? 'new'))
}
</script>

<template>
  <span class="pin">
    <button v-if="!pinned" type="button" class="quiet" :aria-label="label ? `Pin ${label}` : 'Pin to a dashboard'" @click="pin">Pin</button>
    <span v-else role="status" class="pinned">
      <RouterLink :to="{ name: 'dashboard', params: { id: pinned.id } }">{{ pinned.title }}</RouterLink>
      <button type="button" class="plain" @click="undo">Undo</button>
      <button v-if="!choosing" type="button" class="plain" @click="choosing = true">Change</button>
      <select v-else aria-label="Pin to" @change="change(($event.target as HTMLSelectElement).value)">
        <option value="" disabled selected>…</option>
        <option v-for="d in boards" :key="d.id" :value="String(d.id)">{{ d.title }}</option>
        <option value="new">New</option>
      </select>
    </span>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </span>
</template>
