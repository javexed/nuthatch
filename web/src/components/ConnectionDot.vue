<script setup lang="ts">
// Whether what the pages show is current: the stream of the server's
// events is open, or it broke and what is shown is from when it did.
import { computed, onUnmounted, ref, watch } from 'vue'
import { duration } from '../lib/format'
import { useLive } from '../stores/live'

const live = useLive()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
watch(
  () => live.connected,
  (connected) => {
    clearInterval(timer)
    now.value = Date.now()
    if (connected === false) timer = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true },
)
onUnmounted(() => clearInterval(timer))
const since = computed(() => duration(Math.max(1, Math.round((now.value - live.lostAt) / 1000))))
</script>

<template>
  <span v-if="live.connected === true" class="connection live" role="img" aria-label="Live: changes show as they happen" title="Live: changes show as they happen">
    <span class="dot good" aria-hidden="true"></span>
  </span>
  <span v-else-if="live.connected === false" class="connection lost" role="status">
    <span class="dot" aria-hidden="true"></span>Reconnecting… shown as of {{ since }} ago
  </span>
</template>
