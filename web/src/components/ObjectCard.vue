<script setup lang="ts">
// One host or service, in a few lines.
import { computed } from 'vue'
import { duration } from '../lib/format'
import { useLoader } from '../stores/live'
import { api } from '../stores/session'
import Marks from './Marks.vue'
import StateBadge from './StateBadge.vue'

const props = defineProps<{ backend: string; host: string; service?: string }>()
const kind = computed(() => (props.service === undefined || props.service === '' ? 'host' : 'service'))
const COLUMNS = ['state', 'has_been_checked', 'plugin_output', 'last_state_change', 'acknowledged', 'scheduled_downtime_depth', 'notifications_enabled', 'active_checks_enabled', 'is_flapping']

const { data, error, loading } = useLoader(async () => {
  const clean = (text: string) => text.replace(/[\r\n]/g, ' ')
  const answer =
    kind.value === 'host'
      ? await api.query({ table: 'hosts', columns: COLUMNS, headers: [`Filter: name = ${clean(props.host)}`], backends: [props.backend] })
      : await api.query({ table: 'services', columns: COLUMNS, headers: [`Filter: host_name = ${clean(props.host)}`, `Filter: description = ${clean(props.service ?? '')}`], backends: [props.backend] })
  return { row: answer.rows[0] as Record<string, unknown> | undefined, why: answer.errors[props.backend] }
}, [() => [props.backend, props.host, props.service]])

const link = computed(() =>
  kind.value === 'host'
    ? { name: 'host', params: { backend: props.backend, host: props.host } }
    : { name: 'service', params: { backend: props.backend, host: props.host, service: props.service } },
)
</script>

<template>
  <div class="object-card">
    <p v-if="error || data?.why" class="error" role="alert">{{ error || data?.why }}</p>
    <template v-else-if="data?.row">
      <p class="headline">
        <StateBadge :kind="kind" :state="data.row.state" :checked="data.row.has_been_checked" />
        <RouterLink :to="link">{{ kind === 'host' ? host : `${host} / ${service}` }}</RouterLink>
        <Marks :row="data.row" />
      </p>
      <p class="output">{{ data.row.plugin_output }}</p>
      <p v-if="data.row.last_state_change" class="by">for {{ duration(Date.now() / 1000 - Number(data.row.last_state_change)) }}</p>
    </template>
    <p v-else-if="!loading" class="none">{{ kind === 'host' ? host : `${host} / ${service}` }} is not there, or not one of yours.</p>
  </div>
</template>
