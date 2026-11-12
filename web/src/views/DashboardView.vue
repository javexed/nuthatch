<script setup lang="ts">
// A dashboard: its boxes, each showing what the one who looks may see.
// Its owner changes it here: boxes added, taken away and moved.
import type { Dashboard, Widget } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WidgetBox from '../components/WidgetBox.vue'
import { api, useSession } from '../stores/session'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()
const session = useSession()

const dashboard = ref<Dashboard | null>(null)
const error = ref('')
const draft = ref<{ title: string; shared: boolean; widgets: Widget[] } | null>(null)
const saving = ref(false)
const mine = computed(() => dashboard.value?.owner === session.session?.user)
const backends = computed(() => session.session?.backends.map((b) => b.name) ?? [])

async function load() {
  try {
    dashboard.value = await api.dashboard(Number(props.id))
    error.value = ''
    if (route.query.edit === '1' && mine.value) edit()
  } catch (err) {
    error.value = err instanceof ApiError ? (err.status === 404 ? 'There is no such dashboard, or it is not shared.' : err.message) : 'The server cannot be reached.'
  }
}
watch(() => props.id, () => void load(), { immediate: true })

function edit() {
  if (!dashboard.value) return
  draft.value = JSON.parse(JSON.stringify({ title: dashboard.value.title, shared: dashboard.value.shared, widgets: dashboard.value.widgets })) as typeof draft.value
}

const KINDS: { type: Widget['type']; label: string; make: () => Widget }[] = [
  { type: 'totals', label: 'Totals by state', make: () => ({ type: 'totals', of: 'services' }) },
  { type: 'problems', label: 'A list of problems', make: () => ({ type: 'problems', of: 'services', unhandled: true, limit: 10 }) },
  { type: 'object', label: 'One host or service', make: () => ({ type: 'object', backend: backends.value[0] ?? '', host: '' }) },
  { type: 'log', label: 'The latest alerts or notifications', make: () => ({ type: 'log', lines: 'alerts', hours: 24, limit: 10 }) },
]
const adding = ref<Widget['type']>('totals')

function add() {
  const kind = KINDS.find((k) => k.type === adding.value)
  if (kind && draft.value) draft.value.widgets.push(kind.make())
}

function move(n: number, by: number) {
  const list = draft.value?.widgets
  const [box] = list?.splice(n, 1) ?? []
  if (list && box) list.splice(n + by, 0, box)
}

async function save() {
  if (!draft.value || !dashboard.value) return
  saving.value = true
  try {
    // A field left empty is a setting not made.
    const widgets = draft.value.widgets.map((w) => Object.fromEntries(Object.entries(w).filter(([, value]) => value !== '' && value !== null)) as Widget)
    dashboard.value = await api.saveDashboard(dashboard.value.id, { ...draft.value, widgets })
    draft.value = null
    error.value = ''
    void router.replace({ query: {} })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'The server cannot be reached.'
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!dashboard.value || !window.confirm(`Delete the dashboard "${dashboard.value.title}"?`)) return
  await api.deleteDashboard(dashboard.value.id)
  await router.push({ name: 'dashboards' })
}

const label = (type: Widget['type']) => KINDS.find((k) => k.type === type)?.label ?? type
</script>

<template>
  <nav class="crumbs" aria-label="Where this is"><RouterLink :to="{ name: 'dashboards' }">Dashboards</RouterLink></nav>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <template v-if="dashboard && !draft">
    <h1>
      {{ dashboard.title }}
      <span v-if="!mine" class="backend">by {{ dashboard.owner }}</span>
      <span v-else-if="dashboard.shared" class="backend">shared</span>
    </h1>
    <p v-if="mine" class="actions">
      <button type="button" class="quiet" @click="edit">Change</button>
      <button type="button" class="plain" @click="remove">Delete</button>
    </p>
    <div class="dashboard">
      <WidgetBox v-for="(widget, n) in dashboard.widgets" :key="`${n} ${JSON.stringify(widget)}`" :widget="widget" :class="{ wide: widget.type === 'totals' }" />
    </div>
    <p v-if="dashboard.widgets.length === 0" class="none">This dashboard has no boxes yet.</p>
  </template>

  <form v-if="draft" class="dashboard-form" @submit.prevent="save">
    <h1>Change the dashboard</h1>
    <div class="fields">
      <label>Title <input v-model="draft.title" name="title" required maxlength="200" /></label>
      <label class="check"><input v-model="draft.shared" type="checkbox" name="shared" /> Shared: everyone who logs in can open it, and sees in it what is theirs to see</label>
    </div>
    <fieldset v-for="(widget, n) in draft.widgets" :key="n" class="service-fields">
      <legend>Box {{ n + 1 }}: {{ label(widget.type) }}</legend>
      <div class="fields">
        <label>Title <input v-model="widget.title" :name="`box-${n}-title`" maxlength="200" placeholder="one is made if left empty" /></label>
        <template v-if="widget.type === 'totals' || widget.type === 'problems'">
          <label>
            Of
            <select v-model="widget.of" :name="`box-${n}-of`">
              <option value="hosts">hosts</option>
              <option value="services">services</option>
            </select>
          </label>
          <label>Of this host group only <input v-model="widget.hostgroup" :name="`box-${n}-hostgroup`" maxlength="200" /></label>
        </template>
        <template v-if="widget.type === 'problems'">
          <label>Rows <input v-model.number="widget.limit" :name="`box-${n}-limit`" type="number" min="1" max="100" /></label>
          <label class="check"><input v-model="widget.unhandled" type="checkbox" /> Only those nobody has taken care of</label>
        </template>
        <template v-if="widget.type === 'object'">
          <label>
            Backend
            <select v-model="widget.backend" :name="`box-${n}-backend`" required>
              <option v-for="name in backends" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label>Host <input v-model="widget.host" :name="`box-${n}-host`" required maxlength="200" autocapitalize="none" /></label>
          <label>Service <input v-model="widget.service" :name="`box-${n}-service`" maxlength="200" placeholder="empty for the host itself" /></label>
        </template>
        <template v-if="widget.type === 'log'">
          <label>
            Lines
            <select v-model="widget.lines" :name="`box-${n}-lines`">
              <option value="alerts">alerts</option>
              <option value="notifications">notifications</option>
            </select>
          </label>
          <label>Of the last hours <input v-model.number="widget.hours" :name="`box-${n}-hours`" type="number" min="1" max="744" /></label>
          <label>Lines at most <input v-model.number="widget.limit" :name="`box-${n}-limit`" type="number" min="1" max="100" /></label>
        </template>
      </div>
      <div class="actions">
        <button type="button" class="plain" :disabled="n === 0" @click="move(n, -1)">Move up</button>
        <button type="button" class="plain" :disabled="n === draft.widgets.length - 1" @click="move(n, 1)">Move down</button>
        <button type="button" class="plain" @click="draft.widgets.splice(n, 1)">Take away</button>
      </div>
    </fieldset>
    <div class="add-box">
      <label>
        Add a box
        <select v-model="adding" name="add">
          <option v-for="kind in KINDS" :key="kind.type" :value="kind.type">{{ kind.label }}</option>
        </select>
      </label>
      <button type="button" class="quiet" @click="add">Add</button>
    </div>
    <div class="buttons">
      <button type="button" class="quiet" :disabled="saving" @click="draft = null">Cancel</button>
      <button type="submit" :disabled="saving">Save</button>
    </div>
  </form>
</template>
