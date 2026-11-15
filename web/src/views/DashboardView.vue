<script setup lang="ts">
// A dashboard: panels on a grid. Whoever may change it changes it in
// place: panels move by their grip, resize by their corner, come in from
// the tray, and every change is kept at once, with undo. One range for
// the whole dashboard; a host chosen at the top for panels about it.
import type { Dashboard, DashboardBody, Layout, PanelSettings, Range, Scope, Series, Widget } from '@nuthatch/api'
import { ApiError, RANGES } from '@nuthatch/api'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FindTarget from '../components/FindTarget.vue'
import WidgetBox from '../components/WidgetBox.vue'
import { hostGroups, useList } from '../lib/choices'
import { fromInput, toInput } from '../lib/format'
import { type Box, COLUMNS, SIZES, clamp, move, place } from '../lib/layout'
import { labelText } from '../lib/perfdata'
import { type When, spanNow, spanText } from '../lib/range'
import { api, useSession } from '../stores/session'

const props = defineProps<{ id: string }>()
const route = useRoute()
const router = useRouter()
const session = useSession()

const dashboard = ref<Dashboard | null>(null)
const body = ref<DashboardBody | null>(null)
const error = ref('')
const selected = ref<number | null>(null)
/** The panel whose picker is open, inside it: what it shows, or another number. */
const picking = ref<number | null>(null)
const mine = computed(() => dashboard.value?.owner === session.session?.user)
const mayEdit = computed(() => mine.value || dashboard.value?.shared === true)
const narrow = ref(false)
const wall = ref(false)
const arranging = computed(() => mayEdit.value && !wall.value && !narrow.value)

/** The tray. A number and a graph are one kind of panel at two sizes. */
const KINDS: { key: string; label: string; make: () => PanelSettings; size?: [number, number] }[] = [
  { key: 'hosts', label: 'Hosts', make: () => ({ type: 'status' }) },
  { key: 'problems', label: 'Problems', make: () => ({ type: 'problems', of: 'services', show: 'problems' }) },
  { key: 'number', label: 'Number', make: () => ({ type: 'metric', series: [] }), size: [3, 2] },
  { key: 'graph', label: 'Graph', make: () => ({ type: 'metric', series: [] }), size: [6, 4] },
  { key: 'alerts', label: 'Alerts', make: () => ({ type: 'log', lines: 'alerts' }) },
  { key: 'uptime', label: 'Uptime', make: () => ({ type: 'availability' }) },
  { key: 'note', label: 'Note', make: () => ({ type: 'note', text: '' }) },
]
const kindOf = (key: string) => KINDS.find((k) => k.key === key)
const sizeOf = (key: string): [number, number] => {
  const kind = kindOf(key)
  return kind?.size ?? SIZES[kind?.make().type ?? 'note']
}
const tray = ref(false)
const menu = ref(false)

// Kept at once, with undo: every change after a short calm is one step.
const kept = ref('')
const history: string[] = []
let lastSeen = ''
let undoing = false
let calm: ReturnType<typeof setTimeout> | undefined
let saving: ReturnType<typeof setTimeout> | undefined
const canUndo = ref(false)

async function load() {
  try {
    const d = await api.dashboard(Number(props.id))
    dashboard.value = d
    body.value = { title: d.title, shared: d.shared, range: d.range, ...(d.choose_host ? { choose_host: d.choose_host } : {}), widgets: d.widgets }
    kept.value = lastSeen = JSON.stringify(body.value)
    history.length = 0
    canUndo.value = false
    selected.value = null
    picking.value = null
    // An empty dashboard begins with what can go on it.
    tray.value = d.widgets.length === 0
    error.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? (err.status === 404 ? 'Not found' : err.message) : 'Server unreachable'
  }
}
watch(() => props.id, () => void load(), { immediate: true })

watch(
  body,
  (now) => {
    if (!now || !mayEdit.value) return
    const text = JSON.stringify(now)
    clearTimeout(calm)
    calm = setTimeout(() => {
      if (text === lastSeen) return
      if (!undoing) history.push(lastSeen)
      if (history.length > 100) history.shift()
      canUndo.value = history.length > 0
      undoing = false
      lastSeen = text
    }, 400)
    clearTimeout(saving)
    saving = setTimeout(() => void keep(), 700)
  },
  { deep: true },
)

async function keep() {
  if (!body.value || !dashboard.value || dragging || fromTray) return
  const text = JSON.stringify(body.value)
  if (text === kept.value || !body.value.title.trim()) return
  try {
    const saved = await api.saveDashboard(dashboard.value.id, JSON.parse(text) as DashboardBody)
    dashboard.value = saved
    kept.value = text
    error.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
}

/** Closes the step under way: a deliberate change is a step of its own, at
 * once, however quickly the next one comes. Typing waits for a calm. */
function mark() {
  if (!body.value) return
  const now = JSON.stringify(body.value)
  if (now === lastSeen) return
  history.push(lastSeen)
  if (history.length > 100) history.shift()
  canUndo.value = true
  lastSeen = now
}

function undo() {
  mark()
  const before = history.pop()
  if (before === undefined || !body.value) return
  undoing = true
  canUndo.value = history.length > 0
  selected.value = null
  picking.value = null
  body.value = JSON.parse(before) as DashboardBody
}
/** The ⋯ menu closes on a click elsewhere, or Escape. */
function away(event: PointerEvent) {
  if (menu.value && !(event.target instanceof Element && event.target.closest('.more'))) menu.value = false
  if (times.value && !(event.target instanceof Element && event.target.closest('.when'))) times.value = false
}
function keys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    menu.value = false
    times.value = false
    picking.value = null
  }
  const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
  if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey && !typing && arranging.value) {
    event.preventDefault()
    undo()
  }
}
const narrowQuery = window.matchMedia('(max-width: 700px)')
const onNarrow = () => (narrow.value = narrowQuery.matches)
onMounted(() => {
  onNarrow()
  narrowQuery.addEventListener('change', onNarrow)
  window.addEventListener('keydown', keys)
  window.addEventListener('pointerdown', away)
})
onUnmounted(() => {
  narrowQuery.removeEventListener('change', onNarrow)
  window.removeEventListener('keydown', keys)
  window.removeEventListener('pointerdown', away)
  void keep()
})

// The time: one of the ranges, which whoever may change the dashboard
// changes for all (others look at another in the address); or, in the
// address alone, from one moment to another: stepped back or forward,
// dragged across a graph, or typed.
const QUICK: Range[] = ['1h', '6h', '24h', '7d']
const ROLLING: Range[] = ['15m', '1h', '6h', '12h', '24h', '7d', '30d', '90d']
const CALENDAR: Range[] = ['today', 'yesterday', 'week', 'last-month']
const asked = (key: string) => (typeof route.query[key] === 'string' ? route.query[key] : undefined)
const range = computed<Range>(() => {
  const r = asked('range')
  return r !== undefined && r in RANGES ? (r as Range) : (body.value?.range ?? '24h')
})
const fixed = computed(() => {
  const from = Number(asked('from'))
  const to = Number(asked('to'))
  return asked('from') !== undefined && Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null
})
const when = computed<When>(() => fixed.value ?? { range: range.value })
const times = ref(false)
function address(changes: Record<string, string | undefined>) {
  const query: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...route.query, ...changes })) if (typeof v === 'string') query[k] = v
  void router.replace({ query })
}
function setRange(r: Range) {
  times.value = false
  if (mayEdit.value && body.value) {
    mark()
    body.value.range = r
    address({ range: undefined, from: undefined, to: undefined })
  } else address({ range: r === body.value?.range ? undefined : r, from: undefined, to: undefined })
}
function setSpan(span: { from: number; to: number }) {
  times.value = false
  address({ from: String(Math.floor(span.from)), to: String(Math.ceil(span.to)) })
}
const toNow = () => address({ from: undefined, to: undefined })
/** Back or forward by as long as is shown; forward to now is the range again. */
function step(by: -1 | 1) {
  const s = spanNow(when.value)
  const long = s.to - s.from
  const now = Date.now() / 1000
  const to = s.to + by * long
  // Forward to now: the range again, when it is one that ends now.
  if (by > 0 && to >= now - 1 && fixed.value && spanNow({ range: range.value }).live) return toNow()
  setSpan({ from: Math.min(to, now) - long, to: Math.min(to, now) })
}
/** Twice as long, around the same middle; not past now. */
function zoomOut() {
  const s = spanNow(when.value)
  const now = Date.now() / 1000
  const long = (s.to - s.from) * 2
  const to = Math.min(now, (s.from + s.to) / 2 + long / 2)
  setSpan({ from: to - long, to })
}
const later = computed(() => !spanNow(when.value).live)
const typedFrom = ref('')
const typedTo = ref('')
const typedWrong = ref(false)
watch(times, (open) => {
  if (!open) return
  const s = spanNow(when.value)
  typedFrom.value = toInput(s.from)
  typedTo.value = toInput(s.to)
  typedWrong.value = false
})
function typed() {
  const span = { from: fromInput(typedFrom.value), to: fromInput(typedTo.value) }
  typedWrong.value = !(Number.isFinite(span.from) && Number.isFinite(span.to) && span.to > span.from)
  if (!typedWrong.value) setSpan(span)
}

// The host chosen at the top, in the page's address.
const hostList = useList(
  () => [JSON.stringify(body.value?.choose_host)],
  () => {
    const pick = body.value?.choose_host
    if (!pick) return null
    const clean = (t: string) => t.replace(/[\r\n]/g, ' ')
    return api
      .query({ table: 'hosts', columns: ['name'], headers: pick.hostgroup ? [`Filter: groups >= ${clean(pick.hostgroup)}`] : [], sort: [{ column: 'name' }], limit: 2000 })
      .then((a) => a.rows.map((r) => ({ backend: r.backend, host: String(r.name) })))
  },
)
const chosen = computed(() => {
  const list = hostList.value
  if (!body.value?.choose_host || !list || list.length === 0) return null
  const host = typeof route.query.host === 'string' ? route.query.host : ''
  const backend = typeof route.query.backend === 'string' ? route.query.backend : ''
  return list.find((h) => h.host === host && (!backend || h.backend === backend)) ?? list[0] ?? null
})
const chosenKey = computed(() => (chosen.value ? `${chosen.value.backend}\n${chosen.value.host}` : ''))
function choose(key: string) {
  const [backend, host] = key.split('\n')
  void router.replace({ query: { ...route.query, host, backend } })
}
function toggleChooser(on: boolean) {
  if (!body.value) return
  mark()
  if (on) body.value.choose_host = {}
  else delete body.value.choose_host
}

// A panel dragged in from the tray: where it would land, the others moved out of its way.
const incoming = ref<{ layout: Layout } | null>(null)
const shown = computed(() => {
  const widgets = body.value?.widgets ?? []
  const coming = incoming.value
  if (!coming) return widgets
  const boxes = move([...widgets.map((w) => w.layout), coming.layout], widgets.length, coming.layout)
  return widgets.map((w, i) => ({ ...w, layout: boxes[i]! }))
})
const ghost = computed(() => {
  const coming = incoming.value
  if (!coming) return null
  const widgets = body.value?.widgets ?? []
  return move([...widgets.map((w) => w.layout), coming.layout], widgets.length, coming.layout)[widgets.length]!
})
/** On a narrow screen the panels are one column, top to bottom. */
const order = computed(() => shown.value.map((w, n) => ({ w, n })).sort((a, b) => a.w.layout.y - b.w.layout.y || a.w.layout.x - b.w.layout.x))
const cell = (l: Layout) => ({ gridColumn: `${l.x + 1} / span ${l.w}`, gridRow: `${l.y + 1} / span ${l.h}` })

/** A new panel: where it was dropped, or the first free place. One that
 * needs to be told what to show opens its picker; a note, its text. */
function add(settings: PanelSettings, at?: Layout, size?: [number, number]) {
  if (!body.value) return
  mark()
  const [w, h] = size ?? SIZES[settings.type]
  const boxes = body.value.widgets.map((x) => x.layout)
  const layout = at ?? place(boxes, w, h)
  const moved = move([...boxes, layout], boxes.length, layout)
  body.value.widgets.forEach((x, i) => (x.layout = moved[i]!))
  body.value.widgets.push({ ...settings, layout: moved[boxes.length]! } as Widget)
  const n = body.value.widgets.length - 1
  const fresh = !('of' in settings) && !('hostgroup' in settings)
  picking.value = (settings.type === 'metric' && settings.series.length === 0) || ((settings.type === 'status' || settings.type === 'availability') && fresh) ? n : null
  selected.value = settings.type === 'note' && !settings.text ? n : null
  // Where it went, when that is below what shows.
  void nextTick(() => grid.value?.querySelectorAll('.panel')[order.value.findIndex((o) => o.n === n)]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}
function addKind(key: string, at?: Layout) {
  const kind = kindOf(key)
  if (kind) add(kind.make(), at, sizeOf(key))
}
function duplicate(n: number) {
  const w = body.value?.widgets[n]
  if (!w) return
  const { layout, ...settings } = JSON.parse(JSON.stringify(w)) as Widget
  add(settings as PanelSettings, undefined, [layout.w, layout.h])
  selected.value = picking.value = null
}
function removePanel(n: number) {
  mark()
  body.value?.widgets.splice(n, 1)
  selected.value = null
  if (picking.value === n) picking.value = null
  else if (picking.value !== null && picking.value > n) picking.value--
}
function settingsOf(n: number) {
  picking.value = null
  selected.value = selected.value === n ? null : n
}
function pickFor(n: number) {
  selected.value = null
  picking.value = n
}

// Dragging in from the tray. A press that does not move is a click.
let fromTray: { key: string; x: number; y: number; moved: boolean } | null = null
function grabKind(event: PointerEvent, key: string) {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  fromTray = { key, x: event.clientX, y: event.clientY, moved: false }
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
  const [w, h] = sizeOf(fromTray.key)
  const col = (rect.width + 12) / COLUMNS
  const x = Math.floor((event.clientX - rect.left) / col) - Math.floor(w / 2)
  const y = Math.floor((event.clientY - rect.top) / (70 + 12))
  incoming.value = { layout: clamp({ x, y, w, h }) }
}
function dropKind() {
  if (!fromTray) return
  const { key, moved } = fromTray
  fromTray = null
  const at = incoming.value?.layout
  incoming.value = null
  if (!moved) addKind(key)
  else if (at) addKind(key, at)
}
function cancelKind() {
  fromTray = null
  incoming.value = null
}

// Moving and resizing, by pointer: mouse, pen or finger.
const grid = ref<HTMLElement>()
let dragging: { n: number; how: 'move' | 'size'; x: number; y: number; start: Layout; base: Box[]; col: number; row: number } | null = null
function grab(event: PointerEvent, n: number, how: 'move' | 'size') {
  if (!body.value || !grid.value) return
  const rect = grid.value.getBoundingClientRect()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  mark()
  const base = body.value.widgets.map((w) => ({ ...w.layout }))
  dragging = { n, how, x: event.clientX, y: event.clientY, start: { ...base[n]! }, base, col: (rect.width + 12) / COLUMNS, row: 70 + 12 }
  event.preventDefault()
}
function drag(event: PointerEvent) {
  if (!dragging || !body.value) return
  const dx = Math.round((event.clientX - dragging.x) / dragging.col)
  const dy = Math.round((event.clientY - dragging.y) / dragging.row)
  const s = dragging.start
  const to = dragging.how === 'move' ? { ...s, x: s.x + dx, y: s.y + dy } : { ...s, w: s.w + dx, h: s.h + dy }
  const boxes = move(dragging.base, dragging.n, to)
  body.value.widgets.forEach((w, i) => (w.layout = boxes[i]!))
}
function drop() {
  if (!dragging) return
  dragging = null
  mark()
  void keep()
}

async function remove() {
  if (!dashboard.value || !window.confirm(`Delete "${dashboard.value.title}"?`)) return
  await api.deleteDashboard(dashboard.value.id)
  await router.push({ name: 'dashboards' })
}

/** The dashboard as a file, to keep or to give. */
function exportIt() {
  if (!body.value) return
  const { shared: _shared, ...rest } = body.value
  const blob = new Blob([JSON.stringify(rest, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${body.value.title.replace(/[^A-Za-z0-9._-]+/g, '-') || 'dashboard'}.json`
  link.click()
  URL.revokeObjectURL(link.href)
}

// Wall: full screen, nothing but the panels; with `rotate`, the next
// dashboard of the list every so many seconds.
let rotating: ReturnType<typeof setTimeout> | undefined
function toWall() {
  wall.value = true
  selected.value = null
  document.body.classList.add('wall')
  void document.documentElement.requestFullscreen?.().catch(() => undefined)
}
function fromWall() {
  wall.value = false
  document.body.classList.remove('wall')
  clearTimeout(rotating)
  if (route.query.rotate || route.query.wall) void router.replace({ query: {} })
}
const left = () => {
  if (!document.fullscreenElement && wall.value && !route.query.rotate) fromWall()
}
document.addEventListener('fullscreenchange', left)
onUnmounted(() => {
  document.removeEventListener('fullscreenchange', left)
  document.body.classList.remove('wall')
  clearTimeout(rotating)
})
watch(
  () => [props.id, route.query.wall, route.query.rotate],
  () => {
    if (route.query.wall === '1' && !wall.value) toWall()
    clearTimeout(rotating)
    const ids = typeof route.query.rotate === 'string' ? route.query.rotate.split(',').filter((x) => /^\d+$/.test(x)) : []
    if (ids.length < 2) return
    const every = Math.min(3600, Math.max(5, Number(route.query.every) || 30))
    const next = ids[(ids.indexOf(props.id) + 1) % ids.length]!
    rotating = setTimeout(() => void router.replace({ name: 'dashboard', params: { id: next }, query: route.query }), every * 1000)
  },
  { immediate: true },
)

const panel = computed(() => (selected.value === null ? null : (body.value?.widgets[selected.value] ?? null)))
/** Panels say "the chosen host" only when there is one to choose. */
const usesChosen = computed(() => (body.value?.widgets ?? []).some((w) => ((w.type === 'status' || w.type === 'availability') && w.of?.host === '$host') || (w.type === 'metric' && w.series.some((s) => s.host === '$host'))))
const groupList = useList(
  () => [panel.value?.type, !!body.value?.choose_host],
  () => (panel.value?.type === 'problems' || body.value?.choose_host ? hostGroups() : null),
)
function setScope(n: number, scope: Scope) {
  const w = body.value?.widgets[n]
  picking.value = null
  if (!w || (w.type !== 'status' && w.type !== 'availability')) return
  mark()
  delete w.of
  delete w.hostgroup
  Object.assign(w, scope)
}
function addSeries(n: number, s: Series) {
  const w = body.value?.widgets[n]
  picking.value = null
  if (w?.type !== 'metric' || w.series.length >= 8) return
  mark()
  w.series.push(s)
}
function toChosen() {
  mark()
  const w = panel.value
  if (w?.type === 'metric') w.series = w.series.map((s) => ({ ...s, backend: '$host', host: '$host' }))
}
const scopeText = (w: Scope) => (w.of ? (w.of.host === '$host' ? 'The chosen host' : [w.of.host, w.of.service].filter(Boolean).join(' · ')) : (w.hostgroup ?? 'All hosts'))
const seriesText = (s: Series) => [s.host === '$host' ? 'chosen host' : s.host, s.service, labelText(s.label)].filter(Boolean).join(' · ')
</script>

<template>
  <nav v-if="!wall" class="crumbs" aria-label="Where this is"><RouterLink :to="{ name: 'dashboards' }">Dashboards</RouterLink></nav>
  <p v-if="error" class="error" role="alert">{{ error }}</p>

  <template v-if="dashboard && body">
    <div class="page-head dash-head">
      <input v-if="arranging" v-model="body.title" class="title-edit" name="title" required maxlength="200" aria-label="Title" />
      <h1 v-else>
        {{ body.title }}
        <span v-if="!mine && !wall" class="backend">{{ dashboard.owner }}</span>
      </h1>
      <div class="chips when" role="group" aria-label="Range">
        <button type="button" class="chip" aria-label="Earlier" title="Earlier" @click="step(-1)">‹</button>
        <template v-if="!fixed">
          <button v-for="r in QUICK" :key="r" type="button" :class="['chip', { on: range === r }]" :aria-pressed="range === r" @click="setRange(r)">{{ RANGES[r].label }}</button>
          <button v-if="!QUICK.includes(range)" type="button" class="chip on" aria-pressed="true" @click="times = !times">{{ RANGES[range].label }}</button>
        </template>
        <span v-else class="chip on">{{ spanText(fixed) }}</span>
        <button type="button" class="chip" aria-label="Other times" title="Other times" :aria-expanded="times" @click="times = !times">⋯</button>
        <button type="button" class="chip" aria-label="Later" title="Later" :disabled="!later" @click="step(1)">›</button>
        <button v-if="fixed" type="button" class="chip" @click="zoomOut">Zoom out</button>
        <button v-if="fixed" type="button" class="chip" @click="toNow">Now</button>
        <div v-if="times" class="card when-more">
          <div class="chips">
            <button v-for="r in ROLLING" :key="r" type="button" :class="['chip', { on: !fixed && range === r }]" @click="setRange(r)">{{ RANGES[r].label }}</button>
          </div>
          <div class="chips">
            <button v-for="r in CALENDAR" :key="r" type="button" :class="['chip', { on: !fixed && range === r }]" @click="setRange(r)">{{ RANGES[r].label }}</button>
          </div>
          <form class="when-typed" @submit.prevent="typed">
            <label>From <input v-model="typedFrom" name="from" type="datetime-local" required /></label>
            <label>To <input v-model="typedTo" name="to" type="datetime-local" required :aria-invalid="typedWrong" /></label>
            <button type="submit" class="quiet">Show</button>
          </form>
        </div>
      </div>
      <label v-if="body.choose_host && hostList" class="field chooser">
        Host
        <select :value="chosenKey" name="chosen-host" @change="choose(($event.target as HTMLSelectElement).value)">
          <option v-for="h in hostList" :key="`${h.backend}\n${h.host}`" :value="`${h.backend}\n${h.host}`">{{ h.host }}</option>
        </select>
      </label>
      <div v-if="!wall" class="head-actions">
        <button v-if="arranging" type="button" class="quiet" :aria-pressed="tray" @click="tray = !tray">+ Panel</button>
        <button v-if="arranging" type="button" class="quiet" :disabled="!canUndo" @click="undo">Undo</button>
        <button type="button" class="quiet" @click="toWall">Wall</button>
        <span v-if="mayEdit" class="more">
          <button type="button" class="quiet" aria-label="More" :aria-expanded="menu" @click="menu = !menu">⋯</button>
          <div v-if="menu" class="card more-menu">
            <label v-if="mine" class="check"><input v-model="body.shared" type="checkbox" name="shared" /> Shared</label>
            <label v-if="body.choose_host || usesChosen" class="check"><input :checked="!!body.choose_host" type="checkbox" name="choose-host" @change="toggleChooser(($event.target as HTMLInputElement).checked)" /> Choose a host</label>
            <label v-if="body.choose_host" class="field">
              Of host group
              <select v-model="body.choose_host.hostgroup" name="choose-hostgroup">
                <option :value="undefined">All</option>
                <option v-for="g in groupList ?? []" :key="g" :value="g">{{ g }}</option>
              </select>
            </label>
            <button type="button" class="plain" @click="exportIt">Export</button>
            <button v-if="mine" type="button" class="plain" @click="remove">Delete</button>
          </div>
        </span>
      </div>
      <button v-else type="button" class="plain wall-exit" @click="fromWall">Exit</button>
    </div>

    <div v-if="arranging && tray" class="dash-tray" role="toolbar" aria-label="Add a panel">
      <button
        v-for="kind in KINDS"
        :key="kind.key"
        type="button"
        class="quiet tray-item"
        @pointerdown="grabKind($event, kind.key)"
        @pointermove="dragKind"
        @pointerup="dropKind"
        @pointercancel="cancelKind"
        @keydown.enter.prevent="addKind(kind.key)"
        @keydown.space.prevent="addKind(kind.key)"
      >
        + {{ kind.label }}
      </button>
    </div>

    <div class="dash-body">
      <div ref="grid" :class="['dash-grid', { editing: arranging }]" @pointermove="drag" @pointerup="drop" @pointercancel="drop">
        <WidgetBox
          v-for="{ w, n } in order"
          :key="n"
          :widget="w"
          :when="when"
          :chosen-host="chosen"
          :style="cell(w.layout)"
          :class="['panel', { chosen: selected === n, picking: picking === n, 'pick-left': w.layout.x + w.layout.w > 8 }]"
          @zoom="setSpan"
        >
          <template v-if="arranging" #handle>
            <span class="grip" title="Move" @pointerdown="grab($event, n, 'move')">⠿</span>
          </template>
          <template v-if="arranging" #tools>
            <span class="tools">
              <button type="button" class="plain" aria-label="Settings" @click="settingsOf(n)">⚙</button>
              <button type="button" class="plain" aria-label="Duplicate" @click="duplicate(n)">⧉</button>
              <button type="button" class="plain" aria-label="Remove" @click="removePanel(n)">✕</button>
            </span>
            <span class="corner" title="Resize" @pointerdown="grab($event, n, 'size')"></span>
          </template>
          <template v-if="arranging && picking === n" #picker>
            <div class="panel-picker" role="group" aria-label="Choose">
              <FindTarget v-if="w.type === 'metric'" mode="series" label="Search" focus @series="addSeries(n, $event)" />
              <FindTarget v-else mode="scope" label="Search" focus :chooser="!!body.choose_host" @scope="setScope(n, $event)" />
            </div>
          </template>
          <template v-else-if="arranging && w.type === 'metric' && w.series.length === 0" #picker>
            <button type="button" class="quiet" @click="pickFor(n)">Choose a number</button>
          </template>
        </WidgetBox>
        <div v-if="ghost" class="drop-ghost" :style="cell(ghost)" aria-hidden="true"></div>
      </div>
      <aside v-if="arranging && panel && selected !== null" class="card dash-settings" aria-label="Panel settings">
        <div class="settings-head">
          <label>Title <input v-model="panel.title" name="panel-title" maxlength="200" /></label>
          <button type="button" class="plain" aria-label="Close" @click="selected = null">✕</button>
        </div>
        <p v-if="panel.type === 'status' || panel.type === 'availability'" class="row">
          <span>{{ scopeText(panel) }}</span>
          <button type="button" class="quiet" @click="pickFor(selected)">Change</button>
        </p>
        <template v-else-if="panel.type === 'metric'">
          <ul class="series-list">
            <li v-for="(s, i) in panel.series" :key="i">
              <span>{{ seriesText(s) }}</span>
              <button type="button" class="plain" :aria-label="`Remove ${seriesText(s)}`" @click="mark(); panel.series.splice(i, 1)">✕</button>
            </li>
          </ul>
          <button v-if="panel.series.length < 8" type="button" class="quiet" @click="pickFor(selected)">+ Number</button>
          <label v-if="body.choose_host && panel.series.some((s) => s.host !== '$host')" class="check">
            <input type="checkbox" @change="toChosen" /> For the chosen host
          </label>
        </template>
        <template v-else-if="panel.type === 'problems'">
          <fieldset class="field inline">
            <legend>Of</legend>
            <label><input v-model="panel.of" type="radio" value="services" /> services</label>
            <label><input v-model="panel.of" type="radio" value="hosts" /> hosts</label>
          </fieldset>
          <label>
            Show
            <select v-model="panel.show" name="panel-show">
              <option value="problems">Problems</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="downtimes">In a downtime</option>
              <option value="recovered">Recovered</option>
            </select>
          </label>
          <label>
            Host group
            <select v-model="panel.hostgroup" name="panel-hostgroup">
              <option :value="undefined">All</option>
              <option v-for="g in groupList ?? []" :key="g" :value="g">{{ g }}</option>
            </select>
          </label>
        </template>
        <fieldset v-else-if="panel.type === 'log'" class="field inline">
          <legend>Lines</legend>
          <label><input v-model="panel.lines" type="radio" value="alerts" /> alerts</label>
          <label><input v-model="panel.lines" type="radio" value="notifications" /> notifications</label>
        </fieldset>
        <label v-else-if="panel.type === 'note'">Text <textarea v-model="panel.text" name="panel-text" rows="6" maxlength="4000"></textarea></label>
      </aside>
    </div>
    <p v-if="body.widgets.length === 0 && !arranging" class="none">Empty</p>
  </template>
</template>
