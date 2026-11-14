<script setup lang="ts">
// One box of a dashboard.
import type { Widget } from '@nuthatch/api'
import { computed } from 'vue'
import EventLog from './EventLog.vue'
import ObjectCard from './ObjectCard.vue'
import PerfGraphs from './PerfGraphs.vue'
import Sparkline from './Sparkline.vue'
import StatusList from './StatusList.vue'
import Totals from './Totals.vue'

const props = defineProps<{ widget: Widget }>()

const title = computed(() => {
  const w = props.widget
  if (w.title) return w.title
  switch (w.type) {
    case 'totals':
      return `${w.of === 'hosts' ? 'Hosts' : 'Services'}${w.hostgroup ? ` of ${w.hostgroup}` : ''}`
    case 'problems':
      return `${w.unhandled ? 'Unhandled ' : ''}${w.of === 'hosts' ? 'host' : 'service'} problems${w.hostgroup ? ` of ${w.hostgroup}` : ''}`
    case 'object':
      return w.service ? `${w.host} / ${w.service}` : w.host
    case 'log':
      return w.lines === 'alerts' ? 'Alerts' : 'Notifications'
    case 'stat':
    case 'graph':
      return `${w.service ? `${w.host} / ${w.service}` : w.host}${w.label ? ` · ${w.label}` : ''}`
  }
  return ''
})

// Fixed when the box is made, so that it does not ask anew on every look.
const since = Date.now() / 1000
const farAhead = since + 365 * 86400
</script>

<template>
  <section class="card widget" :aria-label="title">
    <h2><slot name="handle" />{{ title }}<slot name="tools" /></h2>
    <Totals v-if="widget.type === 'totals'" :kind="widget.of === 'hosts' ? 'host' : 'service'" :hostgroup="widget.hostgroup" />
    <StatusList
      v-else-if="widget.type === 'problems'"
      :kind="widget.of === 'hosts' ? 'host' : 'service'"
      :base="{
        states: widget.of === 'hosts' ? [1, 2] : [1, 2, 3],
        unhandled: widget.unhandled === true,
        ...(widget.hostgroup ? (widget.of === 'hosts' ? { group: widget.hostgroup } : { hostgroup: widget.hostgroup }) : {}),
      }"
      :page-size="widget.limit ?? 10"
      sort="-last_state_change"
      stacked
      empty="None"
    />
    <ObjectCard v-else-if="widget.type === 'object'" :backend="widget.backend" :host="widget.host" :service="widget.service" />
    <Sparkline v-else-if="widget.type === 'stat'" :backend="widget.backend" :host="widget.host" :service="widget.service" :label="widget.label" :hours="widget.hours" />
    <PerfGraphs v-else-if="widget.type === 'graph'" :backend="widget.backend" :host="widget.host" :service="widget.service" :label="widget.label" :fixed="widget.hours ?? 24" />
    <EventLog v-else-if="widget.type === 'log'" :from="since - (widget.hours ?? 24) * 3600" :to="farAhead" :lines="widget.lines" :page-size="widget.limit ?? 10" />
  </section>
</template>
