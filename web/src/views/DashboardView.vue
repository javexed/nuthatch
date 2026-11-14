<script setup lang="ts">
// A dashboard: panels on a grid. In edit mode a panel is moved by its
// header, resized by its corner, and set up in the side panel.
import type { Dashboard, Layout, Widget } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WidgetBox from '../components/WidgetBox.vue'
import { hostGroups, hostsOf, metricsOf, servicesOf, useList } from '../lib/choices'
import { type Box, COLUMNS, SIZES, clamp, move, place, placed } from '../lib/layout'
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

const KINDS: { type: Widget['type']; label: string; make: () => Widget }[] = [
  { type: 'stat', label: 'Number', make: () => ({ type: 'stat', backend: backends.value[0] ?? '', host: '' }) },
  { type: 'graph', label: 'Graph', make: () => ({ type: 'graph', backend: backends.value[0] ?? '', host: '', hours: 24 }) },
  { type: 'problems', label: 'Problems', make: () => ({ type: 'problems', of: 'services', unhandled: true, limit: 10 }) },
  { type: 'totals', label: 'Totals', make: () => ({ type: 'totals', of: 'services' }) },
  { type: 'object', label: 'Host or service', make: () => ({ type: 'object', backend: backends.value[0] ?? '', host: '' }) },
  { type: 'log', label: 'Log', make: () => ({ type: 'log', lines: 'alerts', hours: 24, limit: 10 }) },
]

// A panel being dragged in from the tray: where it would land, with the
// others moved out of its way.
const incoming = ref<{ type: Widget['type']; layout: Layout } | null>(null)
const shown = computed(() => {
  const widgets = placed(draft.value?.widgets ?? dashboard.value?.widgets ?? [])
  const coming = incoming.value
  if (!coming) return widgets
  const boxes = move([...widgets.map((w) => w.layout!), coming.layout], widgets.length, coming.layout)
  return widgets.map((w, i) => ({ ...w, layout: boxes[i]! }))
})
const ghost = computed(() => {
  const coming = incoming.value
  if (!coming) return null
  const widgets = placed(draft.value?.widgets ?? [])
  return move([...widgets.map((w) => w.layout!), coming.layout], widgets.length, coming.layout)[widgets.length]!
})
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

/** A new panel: where it was dropped, or the first free place. */
function add(type: Widget['type'], at?: Layout) {
  const kind = KINDS.find((k) => k.type === type)
  if (!kind || !draft.value) return
  const [w, h] = SIZES[kind.type]
  const boxes = draft.value.widgets.map((x) => x.layout!)
  const layout = at ?? place(boxes, w, h)
  const moved = move([...boxes, layout], boxes.length, layout)
  draft.value.widgets.forEach((x, i) => (x.layout = moved[i]))
  draft.value.widgets.push({ ...kind.make(), layout: moved[boxes.length]! })
  selected.value = draft.value.widgets.length - 1
}

// Dragging in from the tray. A press that does not move is a click: the
// panel goes to the first free place.
let fromTray: { type: Widget['type']; x: number; y: number; moved: boolean } | null = null
function grabKind(event: PointerEvent, type: Widget['type']) {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  fromTray = { type, x: event.clientX, y: event.clientY, moved: false }
}
function dragKind(event: PointerEvent) {
  if (!fromTray || !grid.value) return
  if (!fromTray.moved && Math.hypot(event.clientX - fromTray.x, event.clientY - fromTray.y) < 6) return
  fromTray.moved = true
  const rect = grid.value.getBoundingClientRect()
  const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top - 40 && event.clientY <= rect.bottom + 200
  if (!inside) {
    incoming.value = null
    return
  }
  const [w, h] = SIZES[fromTray.type]
  const col = (rect.width + 12) / COLUMNS
  const x = Math.floor((event.clientX - rect.left) / col) - Math.floor(w / 2)
  const y = Math.floor((event.clientY - rect.top) / (70 + 12))
  incoming.value = { type: fromTray.type, layout: clamp({ x, y, w, h }) }
}
function dropKind() {
  if (!fromTray) return
  const { type, moved } = fromTray
  fromTray = null
  const at = incoming.value?.layout
  incoming.value = null
  if (!moved) add(type)
  else if (at) add(type, at)
}
function cancelKind() {
  fromTray = null
  incoming.value = null
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

// What the panel's settings are chosen from.
const objectish = (w: Widget | null) => (w && (w.type === 'object' || w.type === 'stat' || w.type === 'graph') ? w : null)
const hostList = useList(
  () => [objectish(panel.value)?.backend],
  () => {
    const w = objectish(panel.value)
    return w?.backend ? hostsOf(w.backend) : null
  },
)
const serviceList = useList(
  () => [objectish(panel.value)?.backend, objectish(panel.value)?.host],
  () => {
    const w = objectish(panel.value)
    return w?.backend && w.host && hostList.value?.includes(w.host) ? servicesOf(w.backend, w.host) : null
  },
)
const metricList = useList(
  () => [panel.value?.type, objectish(panel.value)?.backend, objectish(panel.value)?.host, objectish(panel.value)?.service, serviceList.value],
  () => {
    const w = panel.value
    if (!w || (w.type !== 'stat' && w.type !== 'graph') || !w.backend || !w.host) return null
    if (w.service ? !serviceList.value?.includes(w.service) : !hostList.value?.includes(w.host)) return null
    return metricsOf(w.backend, w.host, w.service || undefined)
  },
)
const groupList = useList(
  () => [panel.value?.type],
  () => (panel.value?.type === 'totals' || panel.value?.type === 'problems' ? hostGroups() : null),
)
/** A name typed that is not in its list, once the list is there. */
const unknown = (list: string[] | null, value: string | undefined) => !!value && list !== null && !list.includes(value)
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
      <span class="grow"></span>
      <button type="button" class="quiet" :disabled="saving" @click="draft = null">Cancel</button>
      <button type="submit" :disabled="saving">Save</button>
    </form>

    <div v-if="draft" class="dash-tray" role="toolbar" aria-label="Add a panel">
      <button
        v-for="kind in KINDS"
        :key="kind.type"
        type="button"
        class="quiet tray-item"
        @pointerdown="grabKind($event, kind.type)"
        @pointermove="dragKind"
        @pointerup="dropKind"
        @pointercancel="cancelKind"
        @keydown.enter.prevent="add(kind.type)"
        @keydown.space.prevent="add(kind.type)"
      >
        + {{ kind.label }}
      </button>
    </div>

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
        <div v-if="ghost" class="drop-ghost" :style="cell(ghost)" aria-hidden="true"></div>
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
          <label>
            Host group
            <input v-model="panel.hostgroup" name="panel-hostgroup" list="dash-groups" maxlength="200" autocomplete="off" :aria-invalid="unknown(groupList, panel.hostgroup)" />
          </label>
          <datalist id="dash-groups"><option v-for="g in groupList ?? []" :key="g" :value="g" /></datalist>
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
          <label>
            Host
            <input v-model="panel.host" name="panel-host" list="dash-hosts" required maxlength="200" autocapitalize="none" autocomplete="off" :aria-invalid="unknown(hostList, panel.host)" />
          </label>
          <datalist id="dash-hosts"><option v-for="h in hostList ?? []" :key="h" :value="h" /></datalist>
          <label>
            Service
            <input v-model="panel.service" name="panel-service" list="dash-services" maxlength="200" autocomplete="off" :aria-invalid="unknown(serviceList, panel.service)" />
          </label>
          <datalist id="dash-services"><option v-for="d in serviceList ?? []" :key="d" :value="d" /></datalist>
        </template>
        <template v-if="panel.type === 'stat' || panel.type === 'graph'">
          <label>
            Metric
            <select v-model="panel.label" name="panel-label">
              <option :value="undefined">First</option>
              <option v-if="panel.label && !metricList?.some((m) => m.label === (panel as { label?: string }).label)" :value="panel.label">{{ panel.label }}</option>
              <option v-for="m in metricList ?? []" :key="m.label" :value="m.label">{{ m.label }} · {{ m.now }}</option>
            </select>
          </label>
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
