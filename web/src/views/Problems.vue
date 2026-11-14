<script setup lang="ts">
// What is wrong now, the newest first: hosts that are not up, and
// services that are not OK on hosts that are up.
import { ref } from 'vue'
import FillingUp from '../components/FillingUp.vue'
import StatusList from '../components/StatusList.vue'

const unhandled = ref(true)
</script>

<template>
  <h1>Problems</h1>
  <label class="check"><input v-model="unhandled" type="checkbox" /> Unhandled only</label>
  <h2>Hosts</h2>
  <StatusList kind="host" :base="{ states: [1, 2], unhandled }" sort="-last_state_change" empty="None" />
  <h2>Services</h2>
  <StatusList kind="service" :base="{ states: [1, 2, 3], unhandled }" sort="-last_state_change" empty="None" />
  <FillingUp />
</template>
