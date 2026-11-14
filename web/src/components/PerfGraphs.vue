<script setup lang="ts">
// The numbers a check gives, each as a small graph over the last hours:
// one line to a graph, each on its own scale, never two scales on one.
import type { GraphSeries } from '@nuthatch/api'
import { computed, ref } from 'vue'
import { dateTime } from '../lib/format'
import { type Point, nearest, shape, short } from '../lib/graph'
import { useLoader } from '../stores/live'
import PinButton from './PinButton.vue'
import { api } from '../stores/session'

/** `label`: one number only; `fixed`: these hours, with no choice of range, and no frame (a dashboard's panel). */
const props = defineProps<{ backend: string; host: string; service?: string; label?: string; fixed?: number }>()

const RANGES = [
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
]
const hours = ref(props.fixed ?? 24)
const { data } = useLoader(() => api.graph(props.backend, props.host, props.service, hours.value), [() => props.backend, () => props.host, () => props.service, hours])

const now = computed(() => {
  // Read with the data, so that the right edge moves when it is loaded anew.
  void data.value
  return Date.now() / 1000
})
const graphs = computed(() =>
  (data.value?.series ?? []).filter((series: GraphSeries) => !props.label || series.label === props.label).map((series: GraphSeries) => {
    const to = now.value
    // Where the history is shorter than the range asked for, the graph
    // begins where the history does, not with hours of nothing.
    const first = series.points[0]?.[0] ?? to
    const from = Math.min(Math.max(to - hours.value * 3600, first), to - 60)
    return { ...series, ...shape(series.points as Point[], from, to), last: series.points[series.points.length - 1] as Point | undefined }
  }),
)

/** Where the pointer is: over which graph, how far along, and the point there. */
const hover = ref<{ label: string; along: number; point: Point } | null>(null)
function point(event: PointerEvent, graph: { label: string; points: [number, number][]; from: number; to: number }) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const along = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
  const found = nearest(graph.points as Point[], graph.from, graph.to, along)
  hover.value = found ? { label: graph.label, along: (found[0] - graph.from) / (graph.to - graph.from), point: found } : null
}
/** A time on the axis: the hour within a day, the day beyond. */
function clock(time: number): string {
  const text = dateTime(time)
  return now.value - time < 86400 ? text.slice(11, 16) : text.slice(5, 16)
}
const value = (v: number, unit: string) => `${short(v)}${unit === '' ? '' : unit.length > 1 ? ` ${unit}` : unit}`
</script>

<template>
  <section v-if="data?.enabled && graphs.length > 0" :class="fixed ? 'graphs bare' : 'card graphs'" aria-label="Graphs">
    <div v-if="!fixed" class="graphs-head">
      <h2>Over time</h2>
      <div class="chips" role="group" aria-label="Range">
        <button v-for="range in RANGES" :key="range.hours" type="button" :class="['chip', { on: hours === range.hours }]" :aria-pressed="hours === range.hours" @click="hours = range.hours">
          {{ range.label }}
        </button>
      </div>
    </div>
    <div class="graph-grid">
      <figure v-for="graph in graphs" :key="graph.label" class="graph">
        <figcaption>
          <span class="name">{{ graph.label }}</span>
          <span v-if="hover && hover.label === graph.label" class="now at">
            {{ value(hover.point[1], graph.unit) }} <span class="when">{{ clock(hover.point[0]) }}</span>
          </span>
          <span v-else-if="graph.last" class="now">{{ value(graph.last[1], graph.unit) }}</span>
          <PinButton v-if="!fixed" :panel="{ type: 'metric', series: [{ backend, host, ...(service !== undefined ? { service } : {}), label: graph.label }] }" :label="graph.label" />
        </figcaption>
        <div
          class="plot"
          role="img"
          :aria-label="`${graph.label}: now ${graph.last ? value(graph.last[1], graph.unit) : 'unknown'}, between ${value(graph.min, graph.unit)} and ${value(graph.max, graph.unit)} over the last ${hours} hours`"
          @pointermove="point($event, graph)"
          @pointerdown="point($event, graph)"
          @pointerleave="hover = null"
        >
          <span class="edge top">{{ value(graph.max, graph.unit) }}</span>
          <span class="edge bottom">{{ value(graph.min, graph.unit) }}</span>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="0" x2="100" y2="0" class="rule" />
            <line x1="0" y1="100" x2="100" y2="100" class="rule" />
            <path :d="graph.path" class="line" />
          </svg>
          <template v-if="hover && hover.label === graph.label">
            <span class="cross" :style="{ left: `${hover.along * 100}%` }"></span>
            <span class="mark-at" :style="{ left: `${hover.along * 100}%`, top: `${100 - ((hover.point[1] - graph.low) / (graph.high - graph.low)) * 100}%` }"></span>
          </template>
        </div>
        <div class="axis" aria-hidden="true"><span>{{ clock(graph.from) }}</span><span>now</span></div>
      </figure>
    </div>
  </section>
</template>
