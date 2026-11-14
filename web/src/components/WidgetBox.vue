<script setup lang="ts">
// One panel of a dashboard. What can be worked out is: its title from what
// it shows, how many rows fit, number or graph by its size, and `$host` as
// the host chosen at the top. Its outline takes the colour of the worst it
// shows.
import type { Series, Target, Widget } from '@nuthatch/api'
import { computed, ref } from 'vue'
import EventLog from './EventLog.vue'
import AvailabilityPanel from './panels/AvailabilityPanel.vue'
import MetricPanel from './panels/MetricPanel.vue'
import NotePanel from './panels/NotePanel.vue'
import ProblemsPanel from './panels/ProblemsPanel.vue'
import StatusPanel from './panels/StatusPanel.vue'

const props = defineProps<{ widget: Widget; seconds: number; chosenHost?: { backend: string; host: string } | null }>()

const resolve = <T extends Target>(t: T): T | null => (t.host === '$host' ? (props.chosenHost ? { ...t, backend: props.chosenHost.backend, host: props.chosenHost.host } : null) : t)
const scope = computed(() => {
  const w = props.widget
  if (w.type !== 'status' && w.type !== 'availability') return {}
  if (!w.of) return w.hostgroup ? { hostgroup: w.hostgroup } : {}
  const of = resolve(w.of)
  return of ? { of } : null
})
const series = computed(() => (props.widget.type === 'metric' ? props.widget.series.map(resolve).filter((s): s is Series => s !== null) : []))
const waiting = computed(() => scope.value === null || (props.widget.type === 'metric' && props.widget.series.length > 0 && series.value.length === 0))

/** Room in the panel, in rows of a list. */
const height = computed(() => props.widget.layout.h * 70 + (props.widget.layout.h - 1) * 12 - 44)
/** A problem takes about 128 px stacked, a log line about 52. */
const problemRows = computed(() => Math.max(1, Math.floor(height.value / 128)))
const listRows = computed(() => Math.max(1, Math.floor(height.value / 52)))
const lineRows = computed(() => Math.max(1, Math.floor(height.value / 26)))
const compact = computed(() => props.widget.layout.w <= 3 || props.widget.layout.h <= 2)

const name = (t: { host: string; service?: string }) => (t.service ? `${t.host} / ${t.service}` : t.host)
const title = computed(() => {
  const w = props.widget
  if (w.title) return w.title
  switch (w.type) {
    case 'status':
    case 'availability': {
      const what = w.of ? name(resolve(w.of) ?? w.of) : (w.hostgroup ?? 'All hosts')
      return w.type === 'availability' ? `Availability · ${what}` : what
    }
    case 'problems': {
      const SHOW = { problems: `${w.of === 'hosts' ? 'Host' : 'Service'} problems`, acknowledged: 'Acknowledged', downtimes: 'In a downtime', recovered: 'Recovered' }
      return `${SHOW[w.show]}${w.hostgroup ? ` · ${w.hostgroup}` : ''}`
    }
    case 'metric': {
      const first = series.value[0] ?? w.series[0]
      if (!first) return 'Metric'
      return `${name(first)}${w.series.length === 1 ? ` · ${first.label}` : ''}`
    }
    case 'log':
      return w.lines === 'alerts' ? 'Alerts' : 'Notifications'
    case 'note':
      return ''
  }
  return ''
})

const worst = ref(0)
const outline = computed(() => (worst.value === 2 ? 'outline-critical' : worst.value === 1 || worst.value === 3 ? 'outline-warning' : ''))
const now = () => Date.now() / 1000
</script>

<template>
  <section :class="['card', 'widget', outline]" :aria-label="title || 'Note'">
    <h2><slot name="handle" />{{ title }}<slot name="tools" /></h2>
    <p v-if="waiting" class="none">Choose a host</p>
    <StatusPanel v-else-if="widget.type === 'status' && scope" :scope="scope" @worst="worst = $event" />
    <ProblemsPanel v-else-if="widget.type === 'problems'" :of="widget.of" :show="widget.show" :hostgroup="widget.hostgroup" :seconds="seconds" :rows="problemRows" @worst="worst = $event" />
    <MetricPanel v-else-if="widget.type === 'metric'" :series="series" :seconds="seconds" :compact="compact" @worst="worst = $event" />
    <EventLog v-else-if="widget.type === 'log'" :from="now() - seconds" :to="now() + 365 * 86400" :lines="widget.lines" :page-size="listRows" />
    <AvailabilityPanel v-else-if="widget.type === 'availability' && scope" :scope="scope" :seconds="seconds" :rows="lineRows" />
    <NotePanel v-else-if="widget.type === 'note'" :text="widget.text" />
  </section>
</template>
