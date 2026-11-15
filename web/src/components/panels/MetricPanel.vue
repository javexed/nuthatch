<script setup lang="ts">
// Numbers of checks over the dashboard's range. Small, the first as a
// number (or a gauge, when it has a maximum), coloured by its thresholds;
// larger, a graph: lines of one unit share a graph, other units get their
// own, never two scales on one.
import type { GraphSeries, Perf, Series } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { perfOf } from '../../lib/choices'
import { type Point, nearest, shape, withUnit } from '../../lib/graph'
import { level } from '../../lib/thresholds'
import { useLoader } from '../../stores/live'
import { api } from '../../stores/session'

const props = defineProps<{ series: Series[]; seconds: number; compact: boolean }>()
const emit = defineEmits<{ worst: [state: number] }>()

const objects = computed(() => {
  const seen = new Map<string, { backend: string; host: string; service?: string }>()
  for (const s of props.series) seen.set(`${s.backend}\n${s.host}\n${s.service ?? ''}`, { backend: s.backend, host: s.host, service: s.service })
  return [...seen.entries()]
})
const hours = computed(() => Math.max(1, Math.ceil(props.seconds / 3600)))
const { data } = useLoader(
  async () => {
    const found = await Promise.all(
      objects.value.map(async ([key, o]) => {
        const [graph, perf] = await Promise.all([api.graph(o.backend, o.host, o.service, hours.value).catch(() => null), perfOf(o).catch(() => [] as Perf[])])
        return [key, { graph: graph?.series ?? [], perf }] as const
      }),
    )
    return new Map(found)
  },
  [() => JSON.stringify(props.series), hours],
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
const nameOf = (s: Series) => [sameHost.value ? '' : s.host, sameService.value ? '' : (s.service ?? ''), s.label, sameBackend.value ? '' : `(${s.backend})`].filter(Boolean).join(' · ')
const value = (v: number | undefined, unit: string) => (v === undefined ? '–' : withUnit(v, unit))
const TONES = ['ok', 'warning', 'critical'] as const

const span = computed(() => {
  void data.value
  const to = Date.now() / 1000
  return { from: to - props.seconds, to }
})

// Small: the first line.
const first = computed(() => lines.value[0])
const spark = computed(() => {
  const l = first.value
  if (!l || l.points.length === 0) return null
  return shape(l.points, Math.min(Math.max(span.value.from, l.points[0]![0]), span.value.to - 60), span.value.to)
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
    const low = values.length ? Math.min(...values) : 0
    const high = values.length ? Math.max(...values) : 1
    const scale = low === high ? { low: low - (Math.abs(low) * 0.1 || 1), high: high + (Math.abs(high) * 0.1 || 1) } : { low, high }
    return {
      unit,
      ...scale,
      lines: group.map((l) => ({ ...l, path: l.points.length ? shape(l.points, span.value.from, span.value.to, scale).path : '' })),
    }
  })
})
const hover = ref<{ unit: string; along: number } | null>(null)
function point(event: PointerEvent, unit: string) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  hover.value = { unit, along: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) }
}
const at = (points: Point[]) => (hover.value ? nearest(points, span.value.from, span.value.to, hover.value.along)?.[1] : undefined)
</script>

<template>
  <p v-if="series.length === 0" class="none">–</p>
  <div v-else-if="compact && first" :class="['stat', TONES[first.state]]">
    <p class="value">{{ value(first.now, first.unit) }}</p>
    <p class="by">{{ nameOf(first.s) }}</p>
    <div v-if="gauge !== null" class="meter" role="meter" :aria-valuenow="Math.round(gauge * 100)" aria-valuemin="0" aria-valuemax="100" :aria-label="nameOf(first.s)">
      <span :style="{ width: `${gauge * 100}%` }"></span>
    </div>
    <svg v-if="spark && gauge === null" class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path :d="spark.path" class="line" /></svg>
  </div>
  <div v-else class="metric-graphs">
    <figure v-for="g in graphs" :key="g.unit" class="graph">
      <div class="plot" role="img" :aria-label="g.lines.map((l) => `${nameOf(l.s)}: ${value(l.now, l.unit)}`).join(', ')" @pointermove="point($event, g.unit)" @pointerdown="point($event, g.unit)" @pointerleave="hover = null">
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
          <span :class="['now', TONES[l.state]]">{{ value(hover && hover.unit === g.unit ? at(l.points) : l.now, l.unit) }}</span>
        </li>
      </ul>
    </figure>
  </div>
</template>
