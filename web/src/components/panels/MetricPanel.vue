<script setup lang="ts">
// Numbers of checks over the dashboard's range. Small, the first as a
// number (or a gauge, when it has a maximum), coloured by its thresholds;
// larger, a graph: lines of one unit share a graph, other units get their
// own, never two scales on one. A number whose check gives its range is
// drawn on all of it, and a count as steps. The number of a service that
// stands for others (checkd's aggregate) comes with its members.
import type { GraphSeries, Perf, Series } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { perfOf } from '../../lib/choices'
import { type Point, nearest, shape, withUnit } from '../../lib/graph'
import { type When, spanNow } from '../../lib/range'
import { countText, labelText } from '../../lib/perfdata'
import { stateOf } from '../../lib/states'
import { level } from '../../lib/thresholds'
import { useLoader } from '../../stores/live'
import { api } from '../../stores/session'

const props = defineProps<{ series: Series[]; when: When; compact: boolean }>()
const emit = defineEmits<{ worst: [state: number]; zoom: [span: { from: number; to: number }]; aggregate: [is: boolean] }>()

const objects = computed(() => {
  const seen = new Map<string, { backend: string; host: string; service?: string }>()
  for (const s of props.series) seen.set(`${s.backend}\n${s.host}\n${s.service ?? ''}`, { backend: s.backend, host: s.host, service: s.service })
  return [...seen.entries()]
})
const { data } = useLoader(
  async () => {
    const found = await Promise.all(
      objects.value.map(async ([key, o]) => {
        const { from, to } = spanNow(props.when)
        const [graph, perf] = await Promise.all([api.graph(o.backend, o.host, o.service, { from, to }).catch(() => null), perfOf(o).catch(() => [] as Perf[])])
        return [key, { graph: graph?.series ?? [], perf }] as const
      }),
    )
    return new Map(found)
  },
  [() => JSON.stringify(props.series), () => JSON.stringify(props.when)],
)

const keyOf = (s: Series) => `${s.backend}\n${s.host}\n${s.service ?? ''}`
const lines = computed(() =>
  props.series.map((s, n) => {
    const held = data.value?.get(keyOf(s))
    const graph = held?.graph.find((g: GraphSeries) => g.label === s.label)
    const perf = held?.perf.find((p) => p.label === s.label)
    const points = (graph?.points ?? []) as Point[]
    const now = perf?.value ?? points[points.length - 1]?.[1]
    return { s, n, points, unit: graph?.unit ?? perf?.unit ?? '', perf, now, state: now === undefined || !perf ? 0 : level(now, perf.warn, perf.crit) }
  }),
)
watch(lines, (all) => emit('worst', Math.max(0, ...all.map((l) => l.state))), { immediate: true })

// Names as short as they can be: what all lines share is left out.
const sameBackend = computed(() => new Set(props.series.map((s) => s.backend)).size === 1)
const sameHost = computed(() => new Set(props.series.map((s) => s.host)).size === 1)
const sameService = computed(() => new Set(props.series.map((s) => s.service ?? '')).size === 1)
const nameOf = (s: Series) => [sameHost.value ? '' : s.host, sameService.value ? '' : (s.service ?? ''), labelText(s.label), sameBackend.value ? '' : `(${s.backend})`].filter(Boolean).join(' · ')
const value = (v: number | undefined, unit: string) => (v === undefined ? '–' : withUnit(v, unit))
/** A line's value now: a count out of its maximum as "3 of 4". */
const nowText = (l: { now: number | undefined; unit: string; perf?: Perf }) => countText(l.now, l.perf) ?? value(l.now, l.unit)
const TONES = ['ok', 'warning', 'critical'] as const

const span = computed(() => {
  void data.value
  return spanNow(props.when)
})

/** The range a check gives its number, for all the lines of a graph; and whether they are counts. */
type Line = (typeof lines.value)[number]
function rangeOf(group: Line[]): { low: number; high: number } | null {
  if (group.length === 0 || !group.every((l) => l.perf && l.perf.min !== null && l.perf.max !== null && l.perf.max > l.perf.min)) return null
  return { low: Math.min(...group.map((l) => l.perf!.min!)), high: Math.max(...group.map((l) => l.perf!.max!)) }
}
const counting = (group: Line[]) => group.length > 0 && group.every((l) => countText(0, l.perf) !== null)

// Small: the first line.
const first = computed(() => lines.value[0])
const spark = computed(() => {
  const l = first.value
  if (!l || l.points.length === 0) return null
  return shape(l.points, Math.min(Math.max(span.value.from, l.points[0]![0]), span.value.to - 60), span.value.to, rangeOf([l]) ?? undefined, counting([l]))
})

// A service that stands for others: its members, and how many are OK.
const aggregate = computed(() => {
  const s = props.series
  return s.length === 1 && s[0]!.label === 'ok' && s[0]!.service !== undefined ? s[0]! : null
})
const { data: held } = useLoader(
  () => {
    const a = aggregate.value
    return a ? api.aggregate(a.backend, a.host, a.service!).catch(() => null) : Promise.resolve(null)
  },
  [() => JSON.stringify(aggregate.value)],
)
const members = computed(() => {
  const a = aggregate.value
  if (!a || !held.value?.aggregate) return null
  return (held.value.members ?? []).map((m) => ({
    key: `${m.host}\n${m.service ?? ''}`,
    name: m.service ? (m.host === a.host ? m.service : `${m.host} / ${m.service}`) : m.host,
    tone: stateOf(m.service ? 'service' : 'host', m.state, m.checked ? 1 : 0).tone,
    to: m.service ? { name: 'service', params: { backend: a.backend, host: m.host, service: m.service } } : { name: 'host', params: { backend: a.backend, host: m.host } },
    ok: m.checked && m.state === 0,
  }))
})
watch(members, (m) => emit('aggregate', m !== null), { immediate: true })
const membersOk = computed(() => {
  const m = members.value ?? []
  const l = first.value
  const counted = l ? countText(l.now, l.perf) : null
  return `${counted ?? `${m.filter((x) => x.ok).length} of ${m.length}`} OK`
})
/** How full, when the number has a maximum (a disk, a share): a bar. */
const gauge = computed(() => {
  const l = first.value
  if (!l?.perf || l.perf.max === null || l.now === undefined) return null
  const min = l.perf.min ?? 0
  return Math.min(1, Math.max(0, (l.now - min) / (l.perf.max - min || 1)))
})

// Larger: one graph per unit.
const graphs = computed(() => {
  const byUnit = new Map<string, typeof lines.value>()
  for (const l of lines.value) byUnit.set(l.unit, [...(byUnit.get(l.unit) ?? []), l])
  return [...byUnit.entries()].map(([unit, group]) => {
    const values = group.flatMap((l) => l.points.map((p) => p[1]))
    const range = rangeOf(group)
    const low = Math.min(...(range ? [range.low] : []), ...(values.length ? values : [0]))
    const high = Math.max(...(range ? [range.high] : []), ...(values.length ? values : [1]))
    const scale = low === high ? { low: low - (Math.abs(low) * 0.1 || 1), high: high + (Math.abs(high) * 0.1 || 1) } : { low, high }
    const steps = counting(group)
    return {
      unit,
      ...scale,
      lines: group.map((l) => ({ ...l, path: l.points.length ? shape(l.points, span.value.from, span.value.to, scale, steps).path : '' })),
    }
  })
})
const hover = ref<{ unit: string; along: number } | null>(null)
function point(event: PointerEvent, unit: string) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  hover.value = { unit, along: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) }
}
// Dragged across a graph (with a mouse or pen): the dashboard looks at that stretch.
const picked = ref<{ start: number; end: number } | null>(null)
function press(event: PointerEvent, unit: string) {
  point(event, unit)
  if (event.pointerType === 'touch' || event.button !== 0 || !hover.value) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  picked.value = { start: hover.value.along, end: hover.value.along }
}
function move(event: PointerEvent, unit: string) {
  point(event, unit)
  if (picked.value && hover.value) picked.value.end = hover.value.along
}
function release() {
  const p = picked.value
  picked.value = null
  if (!p || Math.abs(p.end - p.start) < 0.02) return
  const { from, to } = span.value
  const [a, b] = [Math.min(p.start, p.end), Math.max(p.start, p.end)]
  emit('zoom', { from: from + a * (to - from), to: from + b * (to - from) })
}
const at = (points: Point[]) => (hover.value ? nearest(points, span.value.from, span.value.to, hover.value.along)?.[1] : undefined)
</script>

<template>
  <p v-if="series.length === 0" class="none">–</p>
  <div v-if="members && first" :class="['aggregate', { compact }]">
    <p :class="['value', TONES[first.state]]">{{ membersOk }}</p>
    <ul class="status-tiles">
      <li v-for="m in members" :key="m.key" :class="['status-tile', m.tone]">
        <RouterLink :to="m.to" :title="m.name">{{ m.name }}</RouterLink>
      </li>
    </ul>
  </div>
  <div v-if="compact && first && !members" :class="['stat', TONES[first.state]]">
    <p class="value">{{ nowText(first) }}</p>
    <p class="by">{{ nameOf(first.s) }}</p>
    <div v-if="gauge !== null" class="meter" role="meter" :aria-valuenow="Math.round(gauge * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="nameOf(first.s)">
      <span :style="{ width: `${gauge * 100}%` }"></span>
    </div>
    <svg v-if="spark && gauge === null" class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path :d="spark.path" class="line" /></svg>
  </div>
  <div v-else-if="!compact && series.length > 0" class="metric-graphs">
    <figure v-for="g in graphs" :key="g.unit" class="graph">
      <div class="plot" role="img" :aria-label="g.lines.map((l) => `${nameOf(l.s)}: ${nowText(l)}`).join(', ')" @pointermove="move($event, g.unit)" @pointerdown="press($event, g.unit)" @pointerup="release" @pointercancel="picked = null" @pointerleave="picked || (hover = null)">
        <span v-if="picked && hover?.unit === g.unit" class="zoom-pick" :style="{ left: `${Math.min(picked.start, picked.end) * 100}%`, width: `${Math.abs(picked.end - picked.start) * 100}%` }"></span>
        <span class="edge top">{{ value(g.high, g.unit) }}</span>
        <span class="edge bottom">{{ value(g.low, g.unit) }}</span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="0" x2="100" y2="0" class="rule" />
          <line x1="0" y1="100" x2="100" y2="100" class="rule" />
          <path v-for="l in g.lines" :key="l.n" :d="l.path" :class="['line', `s${(l.n % 8) + 1}`]" />
        </svg>
        <span v-if="hover && hover.unit === g.unit" class="cross" :style="{ left: `${hover.along * 100}%` }"></span>
      </div>
      <ul class="legend">
        <li v-for="l in g.lines" :key="l.n">
          <span :class="['swatch', `s${(l.n % 8) + 1}`]" aria-hidden="true"></span>
          <span class="name">{{ nameOf(l.s) }}</span>
          <span :class="['now', TONES[l.state]]">{{ hover && hover.unit === g.unit ? value(at(l.points), l.unit) : nowText(l) }}</span>
        </li>
      </ul>
    </figure>
  </div>
</template>
