<script setup lang="ts">
// How a service that takes pushes is told its result: the address a job
// calls. Shown to those who may see the config; the address is all a
// caller needs, so it is shown only when asked for.
import type { PushInfo } from '@nuthatch/api'
import { onMounted, ref } from 'vue'
import { dateTime } from '../lib/format'
import { api } from '../stores/session'

const props = defineProps<{ backend: string; host: string; service: string }>()
const info = ref<PushInfo | null>(null)
const shown = ref(false)
const copied = ref(false)

onMounted(async () => {
  try {
    info.value = await api.pushInfo(props.backend, props.host, props.service)
  } catch {
    // Not for this user, or not to be had: no section.
  }
})

function span(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`
  if (seconds % 60 === 0) return `${seconds / 60} minutes`
  return `${seconds} seconds`
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    // Then it is copied by hand.
  }
}
</script>

<template>
  <section v-if="info?.takes" class="card push-info" aria-label="Takes pushes">
    <h2>Takes pushes</h2>
    <p>
      This service is not checked: a job tells it the result by calling an address.
      <template v-if="info.every">It goes CRITICAL when nothing comes for {{ span(info.every) }}.</template>
      <template v-else>Nothing is expected at any set time.</template>
    </p>
    <p class="by">Last result: {{ info.last ? dateTime(info.last) : 'none yet' }}</p>
    <button v-if="!shown" type="button" class="quiet" @click="shown = true">Show the address to call</button>
    <template v-else>
      <pre class="call"><code>curl -fsS {{ info.url ?? `http://&lt;where checkd listens&gt;${info.path}` }}</code></pre>
      <p class="by">
        Whoever has this address can set this one service to any state. Add <code>?state=warning</code> or
        <code>critical</code>, and <code>&amp;output=…</code>, to say more than "done".
        <template v-if="!info.url"> The server does not know where checkd's HTTP API is reached (<code>push_url</code> of the backend).</template>
      </p>
      <button v-if="info.url" type="button" class="quiet" @click="copy(`curl -fsS ${info.url}`)">{{ copied ? 'Copied' : 'Copy' }}</button>
    </template>
  </section>
</template>
