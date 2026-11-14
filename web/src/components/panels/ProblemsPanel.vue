<script setup lang="ts">
// Hosts or services: problems nobody has taken care of, those
// acknowledged, those in a downtime, or those recovered within the range.
// As many rows as the panel has room for.
import type { ProblemsShow } from '@nuthatch/api'
import { computed, watch } from 'vue'
import { EMPTY, type ListFilter, toHeaders } from '../../lib/filters'
import { useLoader } from '../../stores/live'
import { api } from '../../stores/session'
import StatusList from '../StatusList.vue'

const props = defineProps<{ of: 'hosts' | 'services'; show: ProblemsShow; hostgroup?: string; seconds: number; rows: number }>()
const emit = defineEmits<{ worst: [state: number] }>()
const kind = computed(() => (props.of === 'hosts' ? 'host' : 'service'))

const base = computed<Partial<ListFilter>>(() => {
  const bad = props.of === 'hosts' ? [1, 2] : [1, 2, 3]
  const group = props.hostgroup ? (props.of === 'hosts' ? { group: props.hostgroup } : { hostgroup: props.hostgroup }) : {}
  switch (props.show) {
    case 'acknowledged':
      return { states: bad, acknowledged: true, ...group }
    case 'downtimes':
      return { downtime: true, ...group }
    case 'recovered':
      return { states: [0], since: Date.now() / 1000 - props.seconds, ...group }
    default:
      return { states: bad, unhandled: true, ...group }
  }
})

// Problems nobody has taken care of colour the panel's outline.
const { data } = useLoader(
  () => (props.show === 'problems' ? api.stats({ table: props.of, headers: [...toHeaders(kind.value, { ...EMPTY, ...base.value }), 'Stats: state = 2', 'Stats: state >= 1'] }) : Promise.resolve(null)),
  [() => props.show, () => props.of, () => props.hostgroup],
)
watch(
  () => data.value?.groups[0]?.values,
  (values) => emit('worst', !values ? 0 : (values[0] ?? 0) > 0 ? 2 : (values[1] ?? 0) > 0 ? 1 : 0),
  { immediate: true },
)
</script>

<template>
  <StatusList :kind="kind" :base="base" :page-size="Math.max(1, rows)" sort="-last_state_change" stacked :tickable="false" empty="None" />
</template>
