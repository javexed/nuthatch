<script setup lang="ts">
// The state of everything at a glance, and how the backends are.
import { computed } from 'vue'
import Totals from '../components/Totals.vue'
import { useSession } from '../stores/session'

const session = useSession()
const backends = computed(() => session.session?.backends ?? [])
</script>

<template>
  <h1>Overview</h1>
  <section class="card" aria-label="Hosts">
    <h2>Hosts</h2>
    <Totals kind="host" />
  </section>
  <section class="card" aria-label="Services">
    <h2>Services</h2>
    <Totals kind="service" />
  </section>
  <section class="card" aria-label="Backends">
    <h2>Backends</h2>
    <ul class="backends">
      <li v-for="backend in backends" :key="backend.name">
        <strong>{{ backend.name }}</strong>
        <span v-if="backend.ok">answering<template v-if="backend.program_version"> · {{ backend.program_version }}</template></span>
        <span v-else class="error">{{ backend.error ?? 'not answering' }}</span>
      </li>
    </ul>
  </section>
</template>
