<script setup lang="ts">
// The members of a service that stands for others, with their states.
import { computed } from 'vue'
import { useLoader } from '../stores/live'
import { api } from '../stores/session'
import StateBadge from './StateBadge.vue'

const props = defineProps<{ backend: string; host: string; service: string }>()
const { data } = useLoader(() => api.aggregate(props.backend, props.host, props.service))
const members = computed(() => data.value?.members ?? [])
</script>

<template>
  <section v-if="data?.aggregate" class="card members" aria-label="Members">
    <h2>Members<span v-if="data.min" class="by"> · min {{ data.min }}</span></h2>
    <ul>
      <li v-for="m in members" :key="`${m.host}/${m.service ?? ''}`">
        <StateBadge :kind="m.service ? 'service' : 'host'" :state="m.state" :checked="m.checked ? 1 : 0" />
        <RouterLink :to="m.service ? { name: 'service', params: { backend, host: m.host, service: m.service } } : { name: 'host', params: { backend, host: m.host } }">
          {{ m.service ? `${m.host} / ${m.service}` : m.host }}
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
