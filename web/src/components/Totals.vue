<script setup lang="ts">
// How many hosts or services are in each state, and how many of the
// problems nobody has taken care of. Each number leads to its list.
import { computed } from 'vue'
import { type Kind, states } from '../lib/states'
import { useLoader } from '../stores/live'
import { api } from '../stores/session'

const props = defineProps<{ kind: Kind; /** Of this host group only. */ hostgroup?: string }>()

const narrowed = computed(() => {
  const group = props.hostgroup?.replace(/[\r\n]/g, ' ')
  return group ? [`Filter: ${props.kind === 'host' ? 'groups' : 'host_groups'} >= ${group}`] : []
})

/** Per state: all, and those not acknowledged and not in a downtime. */
function counting(): string[] {
  const unhandled = ['Stats: acknowledged = 0', 'Stats: scheduled_downtime_depth = 0']
  if (props.kind === 'service') unhandled.push('Stats: host_acknowledged = 0', 'Stats: host_scheduled_downtime_depth = 0')
  return states(props.kind)
    .flatMap((_, state) => [
      `Stats: state = ${state}`,
      'Stats: has_been_checked = 1',
      'StatsAnd: 2',
      `Stats: state = ${state}`,
      'Stats: has_been_checked = 1',
      ...unhandled,
      `StatsAnd: ${unhandled.length + 2}`,
    ])
    .concat('Stats: has_been_checked = 0')
}

const { data, error } = useLoader(
  () => api.stats({ table: props.kind === 'host' ? 'hosts' : 'services', headers: [...narrowed.value, ...counting()] }),
  [() => props.kind, () => props.hostgroup],
)
const values = computed(() => data.value?.groups[0]?.values ?? [])
const tiles = computed(() => states(props.kind).map((state, n) => ({ ...state, n, all: values.value[2 * n] ?? 0, unhandled: values.value[2 * n + 1] ?? 0 })))
const pending = computed(() => values.value[2 * states(props.kind).length] ?? 0)
const errors = computed(() => Object.entries(data.value?.errors ?? {}))
/** The share of each state, for the bar over the tiles. */
const everything = computed(() => tiles.value.reduce((sum, tile) => sum + tile.all, 0) + pending.value)
const shares = computed(() =>
  everything.value === 0
    ? []
    : [...tiles.value.map((tile) => ({ tone: tile.tone, n: tile.all })), { tone: 'pending', n: pending.value }]
        .filter((part) => part.n > 0)
        .map((part) => ({ ...part, width: `${(100 * part.n) / everything.value}%` })),
)

function link(state: number, unhandled = false) {
  const group = props.hostgroup ? (props.kind === 'host' ? { group: props.hostgroup } : { hostgroup: props.hostgroup }) : {}
  return { name: props.kind === 'host' ? 'hosts' : 'services', query: { state: String(state), ...(unhandled ? { unhandled: '1' } : {}), ...group } }
}
</script>

<template>
  <div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-for="[name, why] in errors" :key="name" class="error" role="alert"><strong>{{ name }}</strong>: {{ why }}</p>
    <div v-if="shares.length > 0" class="bar-of" aria-hidden="true">
      <span v-for="part in shares" :key="part.tone" :class="part.tone" :style="{ width: part.width }"></span>
    </div>
    <ul class="totals">
      <li v-for="tile in tiles" :key="tile.label" :class="['tile', tile.tone, { none: tile.all === 0 }]">
        <RouterLink :to="link(tile.n)"><strong>{{ tile.all }}</strong> {{ tile.label }}</RouterLink>
        <RouterLink v-if="tile.n > 0 && tile.unhandled > 0" class="unhandled" :to="link(tile.n, true)">{{ tile.unhandled }} unhandled</RouterLink>
      </li>
      <li v-if="pending > 0" class="tile pending"><span><strong>{{ pending }}</strong> Pending</span></li>
    </ul>
  </div>
</template>
