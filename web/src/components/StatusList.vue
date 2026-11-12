<script setup lang="ts">
// A list of hosts or of services: narrowed by filters, sorted by a click
// on a column, in pages, with actions on the rows that are ticked. With
// `controls`, what it is narrowed to lives in the page's address, so a
// list can be linked to and comes back as it was.
import type { Row, Sort } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { type Target, recheck, targetName } from '../lib/commands'
import { EMPTY, type ListFilter, fromQuery, toHeaders, toQuery } from '../lib/filters'
import { ago, duration } from '../lib/format'
import { type Kind, states } from '../lib/states'
import { useLive, useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'
import CommandDialog, { type Action } from './CommandDialog.vue'
import Marks from './Marks.vue'
import Pager from './Pager.vue'
import StateBadge from './StateBadge.vue'

const props = withDefaults(
  defineProps<{
    kind: Kind
    /** What the list is always narrowed to, whatever the controls say. */
    base?: Partial<ListFilter>
    controls?: boolean
    /** Of this backend only. */
    backend?: string
    pageSize?: number
    /** The column sorted by at first; a leading '-' for descending. */
    sort?: string
    empty?: string
  }>(),
  { controls: false, pageSize: 50, empty: 'Nothing here.' },
)

const route = useRoute()
const router = useRouter()
const session = useSession()
const live = useLive()

const COLUMNS = {
  host: ['name', 'alias', 'address', 'state', 'has_been_checked', 'last_check', 'last_state_change', 'plugin_output', 'acknowledged',
    'scheduled_downtime_depth', 'notifications_enabled', 'active_checks_enabled', 'is_flapping'],
  service: ['host_name', 'description', 'state', 'has_been_checked', 'last_check', 'last_state_change', 'plugin_output', 'acknowledged',
    'scheduled_downtime_depth', 'notifications_enabled', 'active_checks_enabled', 'is_flapping', 'current_attempt', 'max_check_attempts'],
} as const
type Column = (typeof COLUMNS)[Kind][number]

const nameColumn = computed(() => (props.kind === 'host' ? 'name' : 'host_name'))
const many = computed(() => props.backend === undefined && (session.session?.backends.length ?? 0) > 1)
const canCommand = computed(() => !session.has('read_only'))

// What the controls say: in the address, or kept here.
const own = ref<ListFilter>({ ...EMPTY })
const ownSort = ref(props.sort ?? '')
const ownOffset = ref(0)
const chosen = computed<ListFilter>(() => (props.controls ? fromQuery(route.query) : own.value))
const filter = computed<ListFilter>(() => ({ ...chosen.value, ...props.base }))
const sortBy = computed(() => (props.controls && typeof route.query.sort === 'string' ? route.query.sort : ownSort.value) || nameColumn.value)
const offset = computed(() => (props.controls ? Math.max(0, Number(route.query.offset) || 0) : ownOffset.value))

function update(change: { filter?: ListFilter; sort?: string; offset?: number }) {
  const next = { filter: change.filter ?? chosen.value, sort: change.sort ?? sortBy.value, offset: change.offset ?? 0 }
  if (!props.controls) {
    own.value = next.filter
    ownSort.value = next.sort
    ownOffset.value = next.offset
    return
  }
  const query: Record<string, string> = toQuery(next.filter)
  if (next.sort !== (props.sort ?? nameColumn.value)) query.sort = next.sort
  if (next.offset > 0) query.offset = String(next.offset)
  void router.replace({ query })
}

const sorts = computed<Sort[]>(() => {
  const desc = sortBy.value.startsWith('-')
  const column = sortBy.value.replace(/^-/, '')
  const keys: Sort[] = (COLUMNS[props.kind] as readonly string[]).includes(column) ? [{ column, desc }] : []
  // Ties, and the default order: by name.
  for (const name of props.kind === 'host' ? ['name'] : ['host_name', 'description']) {
    if (!keys.some((k) => k.column === name)) keys.push({ column: name })
  }
  return keys
})

/** The same choices as the column heads, for screens too narrow for them. */
const sortChoices = computed(() => {
  const columns: [string, string][] =
    props.kind === 'host'
      ? [['name', 'Host'], ['state', 'State'], ['last_check', 'Checked'], ['last_state_change', 'Changed']]
      : [['host_name', 'Host'], ['description', 'Service'], ['state', 'State'], ['last_check', 'Checked'], ['last_state_change', 'Changed']]
  return columns.flatMap(([value, label]) => [
    { value, label },
    { value: `-${value}`, label: `${label}, reversed` },
  ])
})

function sortOn(column: string) {
  update({ sort: sortBy.value === column ? `-${column}` : column })
}

function arrow(column: string): string {
  return sortBy.value === column ? ' ▲' : sortBy.value === `-${column}` ? ' ▼' : ''
}

const { data, error, loading } = useLoader(
  () =>
    api.query<Column>({
      table: props.kind === 'host' ? 'hosts' : 'services',
      columns: [...COLUMNS[props.kind]],
      headers: toHeaders(props.kind, filter.value),
      sort: sorts.value,
      offset: offset.value,
      limit: props.pageSize,
      backends: props.backend === undefined ? undefined : [props.backend],
    }),
  [filter, sorts, offset, () => props.backend],
)
const rows = computed(() => data.value?.rows ?? [])
const backendErrors = computed(() => Object.entries(data.value?.errors ?? {}))

// The search box waits for a pause in typing.
const search = ref(chosen.value.search)
let typing: ReturnType<typeof setTimeout> | undefined
watch(search, (text) => {
  clearTimeout(typing)
  typing = setTimeout(() => {
    if (text !== chosen.value.search) update({ filter: { ...chosen.value, search: text } })
  }, 300)
})
watch(() => chosen.value.search, (text) => {
  if (text !== search.value) search.value = text
})

function toggleState(state: number) {
  const now = chosen.value.states
  update({ filter: { ...chosen.value, states: now.includes(state) ? now.filter((s) => s !== state) : [...now, state] } })
}

function target(row: Row<Column>): Target {
  const r = row as Record<string, unknown>
  return props.kind === 'host'
    ? { backend: row.backend, host: String(r.name) }
    : { backend: row.backend, host: String(r.host_name), service: String(r.description) }
}
const keyOf = (row: Row<Column>) => JSON.stringify(target(row))

const ticked = ref(new Set<string>())
watch(rows, (now) => {
  const there = new Set(now.map(keyOf))
  ticked.value = new Set([...ticked.value].filter((k) => there.has(k)))
})
const tickedTargets = computed(() => rows.value.filter((r) => ticked.value.has(keyOf(r))).map(target))
const allTicked = computed(() => rows.value.length > 0 && ticked.value.size === rows.value.length)

function tick(row: Row<Column>, on: boolean) {
  const next = new Set(ticked.value)
  if (on) next.add(keyOf(row))
  else next.delete(keyOf(row))
  ticked.value = next
}

function tickAll(on: boolean) {
  ticked.value = on ? new Set(rows.value.map(keyOf)) : new Set()
}

const dialog = ref<Action | null>(null)
const notice = ref('')

async function recheckTicked() {
  const failures: string[] = []
  for (const t of tickedTargets.value) {
    try {
      await api.command(recheck(t))
    } catch (err) {
      failures.push(`${targetName(t)}: ${err instanceof ApiError ? err.message : 'the server cannot be reached'}`)
    }
  }
  const sent = tickedTargets.value.length - failures.length
  notice.value = failures.length > 0 ? failures.join('; ') : `Asked for ${sent} ${sent === 1 ? 'check' : 'checks'}.`
  live.nudge()
}

function closeDialog() {
  dialog.value = null
  tickAll(false)
}

const hostLink = (row: Row<Column>) => ({ name: 'host', params: { backend: row.backend, host: target(row).host } })
const serviceLink = (row: Row<Column>) => ({ name: 'service', params: { backend: row.backend, host: target(row).host, service: target(row).service } })
const cell = (row: Row<Column>, column: string) => (row as Record<string, unknown>)[column]
const now = () => Date.now() / 1000
</script>

<template>
  <div class="list">
    <div v-if="controls" class="filters">
      <input v-model="search" type="search" name="search" placeholder="Search names and output" aria-label="Search" />
      <div class="chips" role="group" aria-label="States">
        <button
          v-for="(state, n) in states(kind)"
          :key="state.label"
          type="button"
          :class="['chip', state.tone, { on: chosen.states.includes(n) }]"
          :aria-pressed="chosen.states.includes(n)"
          @click="toggleState(n)"
        >
          {{ state.label }}
        </button>
        <button
          type="button"
          :class="['chip', { on: chosen.unhandled }]"
          :aria-pressed="chosen.unhandled"
          title="Not acknowledged and not in a downtime"
          @click="update({ filter: { ...chosen, unhandled: !chosen.unhandled } })"
        >
          Unhandled
        </button>
      </div>
      <p v-if="chosen.group || chosen.host || chosen.hostgroup" class="narrowed">
        <span v-if="chosen.group">Group <strong>{{ chosen.group }}</strong></span>
        <span v-if="chosen.hostgroup">Host group <strong>{{ chosen.hostgroup }}</strong></span>
        <span v-if="chosen.host">Host <strong>{{ chosen.host }}</strong></span>
        <button type="button" class="plain" @click="update({ filter: { ...chosen, group: '', host: '', hostgroup: '' } })">Show all</button>
      </p>
    </div>

    <p v-for="[name, why] in backendErrors" :key="name" class="error" role="alert"><strong>{{ name }}</strong>: {{ why }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="canCommand && ticked.size > 0" class="toolbar" role="toolbar" aria-label="Actions on the ticked rows">
      <span>{{ ticked.size }} ticked</span>
      <button type="button" class="quiet" @click="recheckTicked">Check now</button>
      <button type="button" class="quiet" @click="dialog = 'acknowledge'">Acknowledge</button>
      <button type="button" class="quiet" @click="dialog = 'downtime'">Downtime</button>
    </div>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <label v-if="rows.length > 1" class="sort-select">
      Sort by
      <select :value="sortBy" @change="update({ sort: ($event.target as HTMLSelectElement).value })">
        <option v-for="choice in sortChoices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
      </select>
    </label>
    <label v-if="canCommand && rows.length > 1" class="check tick-all">
      <input type="checkbox" :checked="allTicked" @change="tickAll(($event.target as HTMLInputElement).checked)" /> Tick all
    </label>
    <table v-if="rows.length > 0" class="rows">
      <thead>
        <tr>
          <th v-if="canCommand" class="tick"></th>
          <th><button type="button" class="sort" @click="sortOn('state')">State{{ arrow('state') }}</button></th>
          <th><button type="button" class="sort" @click="sortOn(nameColumn)">Host{{ arrow(nameColumn) }}</button></th>
          <th v-if="kind === 'service'"><button type="button" class="sort" @click="sortOn('description')">Service{{ arrow('description') }}</button></th>
          <th><button type="button" class="sort" @click="sortOn('last_check')">Checked{{ arrow('last_check') }}</button></th>
          <th><button type="button" class="sort" @click="sortOn('last_state_change')">For{{ arrow('last_state_change') }}</button></th>
          <th>Output</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="keyOf(row)">
          <td v-if="canCommand" class="tick">
            <input type="checkbox" :checked="ticked.has(keyOf(row))" :aria-label="`Tick ${targetName(target(row))}`" @change="tick(row, ($event.target as HTMLInputElement).checked)" />
          </td>
          <td class="state"><StateBadge :kind="kind" :state="cell(row, 'state')" :checked="cell(row, 'has_been_checked')" /></td>
          <td class="host">
            <RouterLink :to="hostLink(row)">{{ target(row).host }}</RouterLink>
            <span v-if="many" class="backend">{{ row.backend }}</span>
            <Marks v-if="kind === 'host'" :row="row" />
          </td>
          <td v-if="kind === 'service'" class="service">
            <RouterLink :to="serviceLink(row)">{{ target(row).service }}</RouterLink>
            <Marks :row="row" />
          </td>
          <td class="when" data-label="Checked">{{ ago(Number(cell(row, 'last_check')), now()) }}</td>
          <td class="when" data-label="For">{{ Number(cell(row, 'last_state_change')) ? duration(now() - Number(cell(row, 'last_state_change'))) : '' }}</td>
          <td class="output">{{ cell(row, 'plugin_output') }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading && !error" class="none">{{ empty }}</p>

    <Pager v-if="data && data.total !== null && rows.length > 0" :offset="offset" :limit="pageSize" :total="data.total" @go="update({ offset: $event })" />
    <CommandDialog v-if="dialog" :action="dialog" :targets="tickedTargets" @close="closeDialog" />
  </div>
</template>
