<script setup lang="ts">
// What happened: the engines' logs over a span of time.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import EventLog, { type Lines } from '../components/EventLog.vue'
import RangePicker from '../components/RangePicker.vue'
import type { Span } from '../lib/availability'
import { spanOf } from '../lib/range'
import { useSession } from '../stores/session'

const route = useRoute()
const router = useRouter()
const session = useSession()

// "Now" is fixed while the page is narrowed, so that pages do not shift.
const now = ref(Date.now() / 1000)
const chosen = computed(() => spanOf(route.query, now.value))
const lines = computed<Lines>(() => (route.query.lines === 'notifications' || route.query.lines === 'all' ? route.query.lines : 'alerts'))
const offset = computed(() => Math.max(0, Number(route.query.offset) || 0))
const text = (key: string) => (typeof route.query[key] === 'string' ? (route.query[key] as string) : undefined)

function go(change: Record<string, string | undefined>) {
  const query: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...route.query, offset: undefined, ...change })) {
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

const KINDS: { id: Lines; label: string }[] = [
  { id: 'alerts', label: 'Alerts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'all', label: 'Everything' },
]

function range(id: string) {
  now.value = Date.now() / 1000
  go({ range: id, from: undefined, to: undefined })
}
const custom = (span: Span) => go({ range: undefined, from: String(span.from), to: String(span.to) })
</script>

<template>
  <h1>History</h1>
  <div class="filters">
    <RangePicker :id="chosen.id" :span="chosen.span" @range="range" @custom="custom" />
    <div class="chips" role="group" aria-label="Kinds of line">
      <button v-for="kind in KINDS" :key="kind.id" type="button" :class="['chip', { on: lines === kind.id }]" :aria-pressed="lines === kind.id" @click="go({ lines: kind.id })">
        {{ kind.label }}
      </button>
    </div>
    <input v-model="search" type="search" name="search" placeholder="Search the lines" aria-label="Search" />
    <p v-if="text('host')" class="narrowed">
      <span>Host <strong>{{ text('host') }}</strong></span>
      <span v-if="text('service')">Service <strong>{{ text('service') }}</strong></span>
      <button type="button" class="plain" @click="go({ host: undefined, service: undefined, backend: undefined })">Show all</button>
    </p>
    <p v-if="lines === 'all' && !session.has('all_hosts')" class="notice">
      Lines about the program itself are shown to those who may see all hosts.
    </p>
  </div>
  <EventLog
    :from="chosen.span.from"
    :to="chosen.span.to"
    :lines="lines"
    :search="text('q') ?? ''"
    :backend="text('backend')"
    :host="text('host')"
    :service="text('service')"
    :offset="offset"
    @go="go({ offset: String($event) })"
  />
</template>
