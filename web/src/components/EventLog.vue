<script setup lang="ts">
// Lines of the engines' logs, the newest first: alerts, notifications
// and, for those who may see them, everything else.
import { computed, ref, watch } from 'vue'
import { dateTime } from '../lib/format'
import { literal } from '../lib/filters'
import { stateOf } from '../lib/states'
import { useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'
import Pager from './Pager.vue'

export type Lines = 'alerts' | 'notifications' | 'all'

const props = withDefaults(
  defineProps<{
    from: number
    to: number
    lines?: Lines
    search?: string
    backend?: string
    host?: string
    /** With a host: its service; "" for the host's own lines only. */
    service?: string
    offset?: number
    pageSize?: number
  }>(),
  { lines: 'alerts', search: '', offset: 0, pageSize: 100 },
)
const emit = defineEmits<{ go: [offset: number] }>()
const session = useSession()
const many = computed(() => props.backend === undefined && (session.session?.backends.length ?? 0) > 1)

// The classes of the log table: 1 alerts, 3 notifications.
const CLASSES: Record<Lines, string[]> = { alerts: ['Filter: class = 1'], notifications: ['Filter: class = 3'], all: [] }
const COLUMNS = ['time', 'class', 'type', 'host_name', 'service_description', 'state', 'state_type', 'plugin_output', 'contact_name', 'message'] as const

const { data, error, loading } = useLoader(() => {
  const headers = [`Filter: time >= ${Math.floor(props.from)}`, `Filter: time <= ${Math.ceil(props.to)}`, ...CLASSES[props.lines]]
  const clean = (text: string) => text.replace(/[\r\n]/g, ' ')
  if (props.host !== undefined) headers.push(`Filter: host_name = ${clean(props.host)}`)
  if (props.service !== undefined) headers.push(`Filter: service_description = ${clean(props.service)}`)
  if (props.search.trim() !== '') headers.push(`Filter: message ~~ ${literal(clean(props.search.trim()))}`)
  return api.query({
    table: 'log',
    columns: [...COLUMNS],
    headers,
    sort: [{ column: 'time', desc: true }],
    offset: props.offset,
    limit: props.pageSize,
    backends: props.backend === undefined ? undefined : [props.backend],
  })
}, [() => [props.from, props.to, props.lines, props.search, props.backend, props.host, props.service, props.offset]])

const rows = computed(() => (data.value?.rows ?? []) as (Record<(typeof COLUMNS)[number], unknown> & { backend: string })[])
const errors = computed(() => Object.entries(data.value?.errors ?? {}))

// Each line has a key of its own (the same line twice in a second gets a
// number), so that a new one can be told from those already shown.
const keyed = computed(() => {
  const times = new Map<string, number>()
  return rows.value.map((row) => {
    const base = `${row.backend}|${String(row.time)}|${String(row.message)}`
    const n = times.get(base) ?? 0
    times.set(base, n + 1)
    return { row, key: `${base}|${n}` }
  })
})
/** Lines that came while the page was open: shown for a moment. */
const fresh = ref(new Set<string>())
let asked = true
watch(() => [props.from, props.to, props.lines, props.search, props.backend, props.host, props.service, props.offset], () => (asked = true))
watch(keyed, (now, before) => {
  // Another range or page was asked for: all of it is new, none of it news.
  if (asked) {
    asked = before.length === 0 && now.length === 0
    return
  }
  if (props.offset !== 0) return
  const had = new Set(before.map((line) => line.key))
  const came = now.filter((line) => !had.has(line.key)).map((line) => line.key)
  if (came.length === 0 || came.length === now.length) return
  fresh.value = new Set([...fresh.value, ...came])
  setTimeout(() => (fresh.value = new Set([...fresh.value].filter((key) => !came.includes(key)))), 2500)
})

/** What a line says, without the time and the kind it starts with. */
function rest(row: { message: unknown; type: unknown }): string {
  const message = String(row.message).replace(/^\[\d+\] /, '')
  const kind = String(row.type)
  return message.startsWith(`${kind}: `) ? message.slice(kind.length + 2) : message === kind ? '' : message
}

const isState = (row: { type: unknown }) => /(ALERT|STATE|NOTIFICATION)$/.test(String(row.type)) && !/(DOWNTIME|FLAPPING) ALERT$/.test(String(row.type))
const kindOf = (row: { service_description: unknown }) => (row.service_description ? 'service' : 'host')
const title = (text: unknown) => String(text).toLowerCase().replace(/^./, (c) => c.toUpperCase())
</script>

<template>
  <div class="log">
    <p v-for="[name, why] in errors" :key="name" class="error" role="alert"><strong>{{ name }}</strong>: {{ why }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <ol v-if="rows.length > 0" class="events">
      <li v-for="{ row, key } in keyed" :key="key" :class="{ fresh: fresh.has(key) }">
        <time>{{ dateTime(Number(row.time)) }}</time>
        <span class="what">
          <span v-if="isState(row) && row.host_name" :class="['badge', stateOf(kindOf(row), row.state).tone]">{{ stateOf(kindOf(row), row.state).label }}</span>
          <strong>{{ title(row.type) }}</strong>
          <template v-if="row.host_name && host === undefined">
            <RouterLink :to="{ name: 'host', params: { backend: row.backend, host: String(row.host_name) } }">{{ row.host_name }}</RouterLink>
            <template v-if="row.service_description">
              /
              <RouterLink :to="{ name: 'service', params: { backend: row.backend, host: String(row.host_name), service: String(row.service_description) } }">
                {{ row.service_description }}
              </RouterLink>
            </template>
          </template>
          <span v-else-if="row.service_description && service === undefined">{{ row.service_description }}</span>
          <span v-if="many" class="backend">{{ row.backend }}</span>
          <span v-if="row.state_type === 'SOFT'" class="mark" title="Not confirmed yet by enough checks">soft</span>
          <span v-if="row.contact_name" class="by">to {{ row.contact_name }}</span>
        </span>
        <span class="text">{{ row.plugin_output || (row.host_name ? '' : rest(row)) }}</span>
      </li>
    </ol>
    <p v-else-if="!loading && !error" class="none">None</p>
    <Pager v-if="data && data.total !== null && (data.total > pageSize || offset > 0)" :offset="offset" :limit="pageSize" :total="data.total" @go="emit('go', $event)" />
  </div>
</template>
