<script setup lang="ts">
import { computed, ref } from 'vue'
import ManyDowntime from '../components/ManyDowntime.vue'
import StatusList from '../components/StatusList.vue'
import { useSession } from '../stores/session'

const session = useSession()
const many = ref(false)
const canAdd = computed(() => session.has('config_edit') && (session.session?.config_backends ?? []).length > 0)
</script>

<template>
  <div class="page-head">
    <h1>Hosts</h1>
    <div class="head-actions">
      <RouterLink v-if="canAdd" class="button" :to="{ name: 'config', query: { new: 'host' } }">New host</RouterLink>
      <button v-if="!session.has('read_only')" type="button" class="quiet" @click="many = true">Downtime for many…</button>
    </div>
  </div>
  <StatusList kind="host" controls empty="No host matches." />
  <ManyDowntime v-if="many" kind="host" @close="many = false" />
</template>
