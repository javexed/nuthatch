<script setup lang="ts">
// A first page: the totals of hosts and services by state, and how the
// backends are. It is read again when the server says something changed,
// and once a minute.
import { onMounted, onUnmounted, ref } from 'vue'
import type { StatsAnswer } from '@nuthatch/api'
import { api, useSession } from '../stores/session'

const session = useSession()
const hosts = ref<number[]>([])
const services = ref<number[]>([])
const errors = ref<Record<string, string>>({})
const stop = new AbortController()
let timer: ReturnType<typeof setInterval> | undefined

const HOST_STATES = ['Up', 'Down', 'Unreachable']
const SERVICE_STATES = ['OK', 'Warning', 'Critical', 'Unknown']

function totals(answer: StatsAnswer, states: number): number[] {
  return answer.groups[0]?.values ?? new Array<number>(states).fill(0)
}

async function load() {
  const count = (n: number) => Array.from({ length: n }, (_, state) => `Stats: state = ${state}`)
  const [h, s] = await Promise.all([
    api.stats({ table: 'hosts', headers: count(3) }),
    api.stats({ table: 'services', headers: count(4) }),
  ])
  hosts.value = totals(h, 3)
  services.value = totals(s, 4)
  errors.value = { ...h.errors, ...s.errors }
}

onMounted(() => {
  void load()
  void api.events(() => void load(), stop.signal)
  timer = setInterval(() => void load(), 60000)
})
onUnmounted(() => {
  stop.abort()
  clearInterval(timer)
})
</script>

<template>
  <h1>Overview</h1>
  <section class="card">
    <h2>Hosts</h2>
    <ul class="totals">
      <li v-for="(name, state) in HOST_STATES" :key="name" :class="['state', `host-${state}`, { none: !hosts[state] }]">
        <strong>{{ hosts[state] ?? 0 }}</strong> {{ name }}
      </li>
    </ul>
  </section>
  <section class="card">
    <h2>Services</h2>
    <ul class="totals">
      <li v-for="(name, state) in SERVICE_STATES" :key="name" :class="['state', `service-${state}`, { none: !services[state] }]">
        <strong>{{ services[state] ?? 0 }}</strong> {{ name }}
      </li>
    </ul>
  </section>
  <section class="card">
    <h2>Backends</h2>
    <ul class="backends">
      <li v-for="backend in session.session?.backends ?? []" :key="backend.name">
        <strong>{{ backend.name }}</strong>
        <span v-if="errors[backend.name]" class="error">{{ errors[backend.name] }}</span>
        <span v-else-if="backend.ok">answering</span>
        <span v-else class="error">{{ backend.error ?? 'not answering' }}</span>
      </li>
    </ul>
  </section>
</template>
