<script setup lang="ts">
// A number of a check now, large, with a line of how it went.
import { computed } from 'vue'
import { type Point, shape, withUnit } from '../lib/graph'
import { labelText } from '../lib/perfdata'
import { useLoader } from '../stores/live'
import { api } from '../stores/session'

const props = defineProps<{ backend: string; host: string; service?: string; label?: string; hours?: number }>()
const hours = computed(() => props.hours ?? 6)
const { data } = useLoader(() => api.graph(props.backend, props.host, props.service, hours.value), [() => props.backend, () => props.host, () => props.service, () => props.label, hours])
const series = computed(() => (data.value?.series ?? []).find((s) => !props.label || s.label === props.label))
const drawn = computed(() => {
  const s = series.value
  if (!s || s.points.length === 0) return null
  const to = Date.now() / 1000
  const from = Math.min(Math.max(to - hours.value * 3600, s.points[0]![0]), to - 60)
  return shape(s.points as Point[], from, to)
})
const last = computed(() => series.value?.points[series.value.points.length - 1]?.[1])
</script>

<template>
  <div class="stat">
    <p class="value">{{ last === undefined ? '–' : withUnit(last, series?.unit ?? '') }}</p>
    <p v-if="series" class="by">{{ labelText(series.label) }}</p>
    <svg v-if="drawn" class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path :d="drawn.path" class="line" /></svg>
  </div>
</template>
