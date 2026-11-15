<script setup lang="ts">
// The state of everything at a glance: first whether anything needs
// someone, then the totals, then how the backends are.
import { computed } from 'vue'
import Totals from '../components/Totals.vue'
import { useProblemCount } from '../stores/problems'
import { useSession } from '../stores/session'

const session = useSession()
const backends = computed(() => session.session?.backends ?? [])
const problems = useProblemCount()

const headline = computed(() => {
  const n = problems.total.value
  if (n === 0) return 'Nothing needs attention'
  const parts = [
    problems.hosts.value > 0 ? `${problems.hosts.value} host${problems.hosts.value === 1 ? '' : 's'}` : '',
    problems.services.value > 0 ? `${problems.services.value} service${problems.services.value === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return `${n} problem${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention: ${parts.join(', ')}`
})
</script>

<template>
  <h1>Overview</h1>
  <RouterLink v-if="problems.loaded.value" :to="{ name: 'problems' }" :class="['banner', problems.total.value > 0 ? 'bad' : 'good']">
    <span class="dot" aria-hidden="true"></span>
    <span>{{ headline }}</span>
  </RouterLink>
  <section class="card" aria-label="Hosts">
    <h2>Hosts</h2>
    <Totals kind="host" />
  </section>
  <section class="card" aria-label="Services">
    <h2>Services</h2>
    <Totals kind="service" />
  </section>
  <section class="backends-line" aria-label="Backends">
    <span v-for="backend in backends" :key="backend.name">
      <span :class="['dot', backend.ok ? 'good' : 'bad']" aria-hidden="true"></span>
      <strong>{{ backend.name }}</strong>
      <template v-if="backend.ok"> answering<template v-if="backend.program_version"> · {{ backend.program_version }}</template></template>
      <span v-else class="error"> {{ backend.error ?? 'not answering' }}</span>
    </span>
    <span v-if="backends.some((b) => b.program_version) && session.session?.version" class="by">nuthatch {{ session.session.version }}</span>
  </section>
</template>
