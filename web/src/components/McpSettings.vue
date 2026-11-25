<script setup lang="ts">
// MCP on or off for this nuthatch, for config_edit. Kept as it is changed.
import { onMounted, ref } from 'vue'
import { api } from '../stores/session'

const on = ref<boolean | null>(null)
const busy = ref(false)
const error = ref('')

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

onMounted(async () => {
  try {
    on.value = (await api.mcpSettings()).on
  } catch (err) {
    error.value = message(err)
  }
})

async function set(now: boolean) {
  busy.value = true
  error.value = ''
  try {
    on.value = (await api.setMcpSettings(now)).on
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="card section" aria-label="MCP">
    <div class="section-head">
      <h2>MCP</h2>
      <label class="check">
        <input type="checkbox" name="mcp-on" :checked="on === true" :disabled="busy || on === null" @change="set(($event.target as HTMLInputElement).checked)" />
        On
      </label>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
