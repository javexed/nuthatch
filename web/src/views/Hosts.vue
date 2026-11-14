<script setup lang="ts">
import { ref } from 'vue'
import ManyDowntime from '../components/ManyDowntime.vue'
import StatusList from '../components/StatusList.vue'
import { useSession } from '../stores/session'

const session = useSession()
const many = ref(false)
</script>

<template>
  <div class="page-head">
    <h1>Hosts</h1>
    <button v-if="!session.has('read_only')" type="button" class="quiet" @click="many = true">Downtime for many…</button>
  </div>
  <StatusList kind="host" controls empty="No host matches." />
  <ManyDowntime v-if="many" kind="host" @close="many = false" />
</template>
