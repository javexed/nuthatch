<script setup lang="ts">
// How much of a span of time each host or service was in each state.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import RangePicker from '../components/RangePicker.vue'
import { type Span, availability, percent, showPercent, toCsv } from '../lib/availability'
import { dateTime, duration } from '../lib/format'
import { spanOf } from '../lib/range'
import { type Kind, states } from '../lib/states'
import { useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSession()
const many = computed(() => (session.session?.backends.length ?? 0) > 1)

const now = ref(Date.now() / 1000)
const chosen = computed(() => spanOf(route.query, now.value))
const kind = computed<Kind>(() => (route.query.of === 'services' ? 'service' : 'host'))
const text = (key: string) => (typeof route.query[key] === 'string' ? (route.query[key] as string) : undefined)

function go(change: Record<string, string | undefined>) {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...route.query, ...change })) {
    if (typeof value === 'string' && value !== '') query[key] = value
  }
  void router.replace({ query })
}

const search = ref(text('q') ?? '')
let typing: ReturnType<typeof setTimeout> | undefined
watch(search, (value) => {
  clearTimeout(typing)
  typing = setTimeout(() => {
    if (value !== (text('q') ?? '')) go({ q: value })
  }, 300)
})

// The history is worked out from the log on every asking, so this page
// asks when it is opened or narrowed, not on every change of a state.
const { data, error, loading, reload } = useLoader(
  () => availability(api, kind.value, chosen.value.span, { host: text('host'), search: text('q'), backends: text('backend') ? [text('backend')!] : undefined }),
  [() => [kind.value, chosen.value.span.from, chosen.value.span.to, text('host'), text('q'), text('backend')]],
  { live: false },
)
const rows = computed(() => data.value?.rows ?? [])
const errors = computed(() => Object.entries(data.value?.errors ?? {}))
const names = computed(() => states(kind.value))

function range(id: string) {
  now.value = Date.now() / 1000
  go({ range: id, from: undefined, to: undefined })
}
const custom = (span: Span) => go({ range: undefined, from: String(span.from), to: String(span.to) })

function refresh() {
  if (chosen.value.id === 'custom') void reload()
  else now.value = Date.now() / 1000
}

function download() {
  const blob = new Blob([toCsv(kind.value, chosen.value.span, rows.value)], { type: 'text/csv;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `availability-${kind.value}s-${Math.floor(chosen.value.span.from)}-${Math.floor(chosen.value.span.to)}.csv`
  link.click()
  URL.revokeObjectURL(link.href)
}

const share = (seconds: number, row: { seconds: number[] }) => {
  const total = row.seconds.reduce((sum, s) => sum + s, 0)
  return total > 0 ? `${(seconds / total) * 100}%` : '0'
}
</script>

<template>
  <h1>Availability</h1>
  <div class="filters">
    <div class="chips" role="group" aria-label="Of what">
      <button type="button" :class="['chip', { on: kind === 'host' }]" :aria-pressed="kind === 'host'" @click="go({ of: undefined })">Hosts</button>
      <button type="button" :class="['chip', { on: kind === 'service' }]" :aria-pressed="kind === 'service'" @click="go({ of: 'services' })">Services</button>
    </div>
    <RangePicker :id="chosen.id" :span="chosen.span" @range="range" @custom="custom" />
    <input v-model="search" type="search" name="search" placeholder="Search names" aria-label="Search" />
    <p v-if="text('host')" class="narrowed">
      <span>Host <strong>{{ text('host') }}</strong></span>
      <button type="button" class="plain" @click="go({ host: undefined, backend: undefined })">Show all</button>
    </p>
  </div>
  <p class="span">
    {{ dateTime(chosen.span.from) }} to {{ dateTime(chosen.span.to) }}
    <button type="button" class="plain" @click="refresh">Work out again</button>
    <button v-if="rows.length > 0" type="button" class="plain" @click="download">Download CSV</button>
  </p>
  <p v-for="[name, why] in errors" :key="name" class="error" role="alert"><strong>{{ name }}</strong>: {{ why }}</p>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="loading" class="none">…</p>

  <table v-if="rows.length > 0" class="rows availability">
    <thead>
      <tr>
        <th>Host</th>
        <th v-if="kind === 'service'">Service</th>
        <th v-for="state in names" :key="state.label">{{ state.label }}</th>
        <th>Share</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="`${row.backend} ${row.host} ${row.service}`">
        <td class="host">
          <RouterLink :to="{ name: 'host', params: { backend: row.backend, host: row.host } }">{{ row.host }}</RouterLink>
          <span v-if="many" class="backend">{{ row.backend }}</span>
        </td>
        <td v-if="kind === 'service'" class="service">
          <RouterLink :to="{ name: 'service', params: { backend: row.backend, host: row.host, service: row.service } }">{{ row.service }}</RouterLink>
        </td>
        <td v-for="(state, n) in names" :key="state.label" class="when" :data-label="state.label" :title="duration(row.seconds[n] ?? 0)">
          {{ showPercent(percent(row, n)) }}
        </td>
        <td class="output">
          <span class="bar-of" role="img" :aria-label="`${showPercent(percent(row, 0))} ${names[0]?.label}`">
            <span v-for="(state, n) in names" :key="state.label" :class="state.tone" :style="{ width: share(row.seconds[n] ?? 0, row) }"></span>
          </span>
          <span v-if="row.unmonitored > 0" class="by">not monitored for {{ duration(row.unmonitored) }}</span>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else-if="!loading && !error" class="none">None</p>
</template>
