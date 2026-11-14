<script setup lang="ts">
// A dashboard: panels on a grid. In edit mode a panel is moved by its
// header, resized by its corner, and set up in the side panel.
import type { Dashboard, Layout, Widget } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WidgetBox from '../components/WidgetBox.vue'
import { type Box, COLUMNS, move, place } from '../lib/layout'
import { api, useSession } from '../stores/session'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()
const session = useSession()

const dashboard = ref<Dashboard | null>(null)
const error = ref('')
const draft = ref<{ title: string; shared: boolean; widgets: Widget[] } | null>(null)
const saving = ref(false)
const selected = ref<number | null>(null)
const mine = computed(() => dashboard.value?.owner === session.session?.user)
const mayEdit = computed(() => mine.value || dashboard.value?.shared === true)
const backends = computed(() => session.session?.backends.map((b) => b.name) ?? [])

const SIZES: Record<Widget['type'], [number, number]> = { totals: [12, 3], problems: [6, 4], object: [4, 3], log: [6, 4], stat: [3, 2], graph: [6, 3] }
const KINDS: { type: Widget['type']; label: string; make: () => Widget }[] = [
  { type: 'stat', label: 'Number', make: () => ({ type: 'stat', backend: backends.value[0] ?? '', host: '' }) },
  { type: 'graph', label: 'Graph', make: () => ({ type: 'graph', backend: backends.value[0] ?? '', host: '', hours: 24 }) },
  { type: 'problems', label: 'Problems', make: () => ({ type: 'problems', of: 'services', unhandled: true, limit: 10 }) },
  { type: 'totals', label: 'Totals', make: () => ({ type: 'totals', of: 'services' }) },
  { type: 'object', label: 'Host or service', make: () => ({ type: 'object', backend: backends.value[0] ?? '', host: '' }) },
  { type: 'log', label: 'Log', make: () => ({ type: 'log', lines: 'alerts', hours: 24, limit: 10 }) },
]
const adding = ref<Widget['type']>('stat')

/** Every panel with a place: those without one get the first free. */
function placed(widgets: Widget[]): Widget[] {
  const boxes: Box[] = []
  return widgets.map((w) => {
    const [width, height] = SIZES[w.type]
    const layout: Layout = w.layout ?? place(boxes, width, height)
    boxes.push(layout)
    return { ...w, layout }
  })
}

const shown = computed(() => placed(draft.value?.widgets ?? dashboard.value?.widgets ?? []))
/** On a narrow screen the panels are one column, top to bottom. */
const order = computed(() => shown.value.map((w, n) => ({ w, n })).sort((a, b) => a.w.layout!.y - b.w.layout!.y || a.w.layout!.x - b.w.layout!.x))
const cell = (l: Layout) => ({ gridColumn: `${l.x + 1} / span ${l.w}`, gridRow: `${l.y + 1} / span ${l.h}` })

async function load() {
  try {
    dashboard.value = await api.dashboard(Number(props.id))
    error.value = ''
    if (route.query.edit === '1' && mayEdit.value) edit()
  } catch (err) {
    error.value = err instanceof ApiError ? (err.status === 404 ? 'Not found' : err.message) : 'Server unreachable'
  }
}
watch(() => props.id, () => void load(), { immediate: true })

function edit() {
  if (!dashboard.value) return
  draft.value = JSON.parse(JSON.stringify({ title: dashboard.value.title, shared: dashboard.value.shared, widgets: placed(dashboard.value.widgets) })) as typeof draft.value
  selected.value = null
}

function add() {
  const kind = KINDS.find((k) => k.type === adding.value)
  if (!kind || !draft.value) return
  const [w, h] = SIZES[kind.type]
  draft.value.widgets.push({ ...kind.make(), layout: place(draft.value.widgets.map((x) => x.layout!), w, h) })
  selected.value = draft.value.widgets.length - 1
}

function removePanel(n: number) {
  draft.value?.widgets.splice(n, 1)
  selected.value = null
}

// Moving and resizing, by pointer: mouse, pen or finger.
const grid = ref<HTMLElement>()
let dragging: { n: number; how: 'move' | 'size'; x: number; y: number; start: Layout; base: Box[]; col: number; row: number } | null = null
function grab(event: PointerEvent, n: number, how: 'move' | 'size') {
  if (!draft.value || !grid.value) return
  const rect = grid.value.getBoundingClientRect()
  const gap = 12
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  const base = draft.value.widgets.map((w) => ({ ...w.layout! }))
  dragging = { n, how, x: event.clientX, y: event.clientY, start: { ...base[n]! }, base, col: (rect.width + gap) / COLUMNS, row: 70 + gap }
  event.preventDefault()
}
function drag(event: PointerEvent) {
  if (!dragging || !draft.value) return
  const dx = Math.round((event.clientX - dragging.x) / dragging.col)
  const dy = Math.round((event.clientY - dragging.y) / dragging.row)
  const s = dragging.start
  const to = dragging.how === 'move' ? { ...s, x: s.x + dx, y: s.y + dy } : { ...s, w: s.w + dx, h: s.h + dy }
  const boxes = move(dragging.base, dragging.n, to)
  draft.value.widgets.forEach((w, i) => (w.layout = boxes[i]))
}
function drop() {
  dragging = null
}

async function save() {
  if (!draft.value || !dashboard.value) return
  saving.value = true
  try {
    // A field left empty is a setting not made.
    const widgets = draft.value.widgets.map((w) => Object.fromEntries(Object.entries(w).filter(([, value]) => value !== '' && value !== null)) as Widget)
    dashboard.value = await api.saveDashboard(dashboard.value.id, { ...draft.value, widgets })
    draft.value = null
    selected.value = null
    error.value = ''
    void router.replace({ query: {} })
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!dashboard.value || !window.confirm(`Delete "${dashboard.value.title}"?`)) return
  await api.deleteDashboard(dashboard.value.id)
  await router.push({ name: 'dashboards' })
}

// Wall: full screen, nothing but the panels.
const wall = ref(false)
function toWall() {
  wall.value = true
  document.body.classList.add('wall')
  void document.documentElement.requestFullscreen?.().catch(() => undefined)
}
function fromWall() {
  wall.value = false
  document.body.classList.remove('wall')
}
const left = () => {
  if (!document.fullscreenElement) fromWall()
}
document.addEventListener('fullscreenchange', left)
onUnmounted(() => {
  document.removeEventListener('fullscreenchange', left)
  fromWall()
})

const panel = computed(() => (selected.value === null ? null : (draft.value?.widgets[selected.value] ?? null)))
</script>

<template>
  <nav v-if="!wall" class="crumbs" aria-label="Where this is"><RouterLink :to="{ name: 'dashboards' }">Dashboards</RouterLink></nav>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <template v-if="dashboard">
    <div v-if="!draft" class="page-head">
      <h1>
        {{ dashboard.title }}
        <span v-if="!mine" class="backend">{{ dashboard.owner }}</span>
        <span v-else-if="dashboard.shared" class="backend">shared</span>
      </h1>
      <div v-if="!wall" class="head-actions">
        <button v-if="mayEdit" type="button" class="quiet" @click="edit">Edit</button>
        <button type="button" class="quiet" @click="toWall">Wall</button>
        <button v-if="mine" type="button" class="plain" @click="remove">Delete</button>
      </div>
      <button v-else type="button" class="plain wall-exit" @click="fromWall">Exit</button>
    </div>
    <form v-else class="dash-edit" @submit.prevent="save">
      <input v-model="draft.title" name="title" required maxlength="200" aria-label="Title" class="title" />
      <label v-if="mine" class="check"><input v-model="draft.shared" type="checkbox" name="shared" /> Shared</label>
      <select v-model="adding" name="add" aria-label="Panel">
        <option v-for="kind in KINDS" :key="kind.type" :value="kind.type">{{ kind.label }}</option>
      </select>
      <button type="button" class="quiet" @click="add">Add</button>
      <span class="grow"></span>
      <button type="button" class="quiet" :disabled="saving" @click="draft = null">Cancel</button>
      <button type="submit" :disabled="saving">Save</button>
    </form>

    <div class="dash-body">
      <div ref="grid" :class="['dash-grid', { editing: draft }]" @pointermove="drag" @pointerup="drop" @pointercancel="drop">
        <WidgetBox
          v-for="{ w, n } in order"
          :key="`${n} ${draft ? '' : JSON.stringify(w)}`"
          :widget="w"
          :style="cell(w.layout!)"
          :class="['panel', { chosen: selected === n }]"
        >
          <template v-if="draft" #handle>
            <span class="grip" title="Move" @pointerdown="grab($event, n, 'move')">⠿</span>
          </template>
          <template v-if="draft" #tools>
            <span class="tools">
              <button type="button" class="plain" aria-label="Settings" @click="selected = selected === n ? null : n">⚙</button>
              <button type="button" class="plain" aria-label="Remove" @click="removePanel(n)">✕</button>
            </span>
            <span class="corner" title="Resize" @pointerdown="grab($event, n, 'size')"></span>
          </template>
        </WidgetBox>
      </div>
      <aside v-if="draft && panel" class="card dash-settings" aria-label="Panel settings">
        <label>Title <input v-model="panel.title" name="panel-title" maxlength="200" /></label>
        <template v-if="panel.type === 'totals' || panel.type === 'problems'">
          <label>
            Of
            <select v-model="panel.of" name="panel-of">
              <option value="hosts">hosts</option>
              <option value="services">services</option>
            </select>
          </label>
          <label>Host group <input v-model="panel.hostgroup" name="panel-hostgroup" maxlength="200" /></label>
        </template>
        <template v-if="panel.type === 'problems'">
          <label>Rows <input v-model.number="panel.limit" name="panel-limit" type="number" min="1" max="100" /></label>
          <label class="check"><input v-model="panel.unhandled" type="checkbox" /> Unhandled only</label>
        </template>
        <template v-if="panel.type === 'object' || panel.type === 'stat' || panel.type === 'graph'">
          <label v-if="backends.length > 1">
            Backend
            <select v-model="panel.backend" name="panel-backend" required>
              <option v-for="name in backends" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label>Host <input v-model="panel.host" name="panel-host" required maxlength="200" autocapitalize="none" /></label>
          <label>Service <input v-model="panel.service" name="panel-service" maxlength="200" /></label>
        </template>
        <template v-if="panel.type === 'stat' || panel.type === 'graph'">
          <label>Number <input v-model="panel.label" name="panel-label" maxlength="200" placeholder="first" /></label>
          <label>Hours <input v-model.number="panel.hours" name="panel-hours" type="number" min="1" max="744" /></label>
        </template>
        <template v-if="panel.type === 'log'">
          <label>
            Lines
            <select v-model="panel.lines" name="panel-lines">
              <option value="alerts">alerts</option>
              <option value="notifications">notifications</option>
            </select>
          </label>
          <label>Hours <input v-model.number="panel.hours" name="panel-hours" type="number" min="1" max="744" /></label>
          <label>Rows <input v-model.number="panel.limit" name="panel-limit" type="number" min="1" max="100" /></label>
        </template>
        <button type="button" class="quiet" @click="selected = null">Done</button>
      </aside>
    </div>
    <p v-if="shown.length === 0 && !draft" class="none">Empty</p>
  </template>
</template>
