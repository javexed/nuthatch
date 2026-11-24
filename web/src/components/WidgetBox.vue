<script setup lang="ts">
// One panel of a dashboard. What can be worked out is: its title from what
// it shows, how many rows fit, and number or graph by its size. A panel
// that follows shows what is chosen at the dashboard's top (everything,
// for All) and is marked so. Its outline takes the colour of the worst it
// shows.
import type { Scope, Widget } from '@nuthatch/api'
import { computed, ref } from 'vue'
import { membersOf, seriesOf } from '../lib/following'
import { labelText } from '../lib/perfdata'
import { type When, spanNow } from '../lib/range'
import { type Focus, scopeOf, subjectName } from '../lib/subjects'
import { useLoader } from '../stores/live'
import EventLog from './EventLog.vue'
import AvailabilityPanel from './panels/AvailabilityPanel.vue'
import MetricPanel from './panels/MetricPanel.vue'
import NotePanel from './panels/NotePanel.vue'
import ProblemsPanel from './panels/ProblemsPanel.vue'
import StatusPanel from './panels/StatusPanel.vue'

/** `focus`: what is chosen at the top; null for All, 'waiting' while a host is yet to be picked. */
const props = defineProps<{ widget: Widget; when: When; focus?: Focus | null | 'waiting' }>()
const emit = defineEmits<{ zoom: [span: { from: number; to: number }] }>()

const follows = computed(() => 'follows' in props.widget && props.widget.follows === true)
const focused = computed<Focus | null>(() => (props.focus && props.focus !== 'waiting' ? props.focus : null))
const waiting = computed(() => follows.value && props.focus === 'waiting')

const scope = computed<Scope>(() => {
  const w = props.widget
  if (w.type !== 'status' && w.type !== 'availability') return {}
  if (follows.value) return scopeOf(focused.value)
  return w.of ? { of: w.of } : w.hostgroup ? { hostgroup: w.hostgroup } : w.servicegroup ? { servicegroup: w.servicegroup } : {}
})
/** A problems panel's filter: its own, or what is chosen. */
const problemsOf = computed(() => {
  const w = props.widget
  if (w.type !== 'problems') return {}
  if (!follows.value) return { hostgroup: w.hostgroup, servicegroup: w.servicegroup }
  const f = focused.value
  return f?.kind === 'host' ? { host: f.host } : f?.kind === 'hostgroup' ? { hostgroup: f.name } : f?.kind === 'servicegroup' ? { servicegroup: f.name } : {}
})

// What a following log or graph shows depends on who the members are now.
const { data: followed } = useLoader(
  async () => {
    const w = props.widget
    if (!follows.value || waiting.value) return null
    if (w.type === 'log') return { members: await membersOf(focused.value), series: [] }
    if (w.type === 'metric') return { members: null, series: await seriesOf(w.numbers ?? [], focused.value) }
    return null
  },
  [() => JSON.stringify(props.widget.type === 'metric' ? props.widget.numbers : props.widget.type), () => JSON.stringify(props.focus), () => follows.value],
)
const series = computed(() => (props.widget.type !== 'metric' ? [] : follows.value ? (followed.value?.series ?? []) : props.widget.series))
/** Room in the panel, in rows of a list. */
const height = computed(() => props.widget.layout.h * 70 + (props.widget.layout.h - 1) * 12 - 44)
/** A problem takes about 128 px stacked, a log line about 52. */
const problemRows = computed(() => Math.max(1, Math.floor(height.value / 128)))
const listRows = computed(() => Math.max(1, Math.floor(height.value / 52)))
const lineRows = computed(() => Math.max(1, Math.floor(height.value / 26)))
const compact = computed(() => props.widget.layout.w <= 3 || props.widget.layout.h <= 2)

const name = (t: { host: string; service?: string }) => (t.service ? `${t.host} / ${t.service}` : t.host)
/** What is chosen, in a title: nothing for All. */
const about = computed(() => (focused.value ? subjectName(focused.value) : ''))
const title = computed(() => {
  const w = props.widget
  if (w.title) return w.title
  switch (w.type) {
    case 'status':
    case 'availability': {
      const s = scope.value
      const what = s.of ? name(s.of) : (s.hostgroup ?? s.servicegroup ?? 'All hosts')
      return w.type === 'availability' ? `Uptime · ${what}` : what
    }
    case 'problems': {
      const SHOW = { problems: `${w.of === 'hosts' && !problemsOf.value.servicegroup ? 'Host' : 'Service'} problems`, acknowledged: 'Acknowledged', downtimes: 'In a downtime', recovered: 'Recovered' }
      const group = follows.value ? about.value : (w.hostgroup ?? w.servicegroup ?? '')
      return `${SHOW[w.show]}${group ? ` · ${group}` : ''}`
    }
    case 'metric': {
      if (follows.value) {
        const n = w.numbers?.[0]
        if (!n) return compact.value ? 'Number' : 'Graph'
        return [n.service, labelText(n.label)].filter(Boolean).join(' · ')
      }
      const first = w.series[0]
      if (!first) return compact.value ? 'Number' : 'Graph'
      return `${name(first)}${w.series.length === 1 ? ` · ${labelText(first.label)}` : ''}`
    }
    case 'log': {
      const what = w.lines === 'alerts' ? 'Alerts' : 'Notifications'
      return follows.value && about.value ? `${what} · ${about.value}` : what
    }
    case 'note':
      return ''
  }
  return ''
})

const worst = ref(0)
const outline = computed(() => (worst.value === 2 ? 'outline-critical' : worst.value === 1 || worst.value === 3 ? 'outline-warning' : ''))
/** The log: to the end of the span, or (while it ends now) whatever comes in. */
const logSpan = () => {
  const s = spanNow(props.when)
  return { from: s.from, to: s.live ? s.to + 365 * 86400 : s.to }
}
</script>

<template>
  <section :class="['card', 'widget', outline, { follows }]" :aria-label="title || 'Note'">
    <h2><slot name="handle" /><span v-if="follows" class="follow-mark" title="Follows" aria-hidden="true"></span>{{ title }}<slot name="tools" /></h2>
    <slot name="picker" />
    <p v-if="waiting" class="none">Choose a host</p>
    <StatusPanel v-else-if="widget.type === 'status'" :scope="scope" @worst="worst = $event" />
    <ProblemsPanel v-else-if="widget.type === 'problems'" :of="widget.of" :show="widget.show" v-bind="problemsOf" :when="when" :rows="problemRows" @worst="worst = $event" />
    <template v-else-if="widget.type === 'metric'">
      <p v-if="follows && followed && series.length === 0 && (widget.numbers ?? []).length > 0" class="none">None</p>
      <MetricPanel v-else-if="!follows || followed" :series="series" :when="when" :compact="compact" @worst="worst = $event" @zoom="emit('zoom', $event)" />
    </template>
    <template v-else-if="widget.type === 'log'">
      <EventLog v-if="!follows || followed" :from="logSpan().from" :to="logSpan().to" :lines="widget.lines" :page-size="listRows" :members="followed?.members ?? undefined" />
    </template>
    <AvailabilityPanel v-else-if="widget.type === 'availability'" :scope="scope" :when="when" :rows="lineRows" />
    <NotePanel v-else-if="widget.type === 'note'" :text="widget.text" />
  </section>
</template>
