<script setup lang="ts">
// The assistant's API key, for config_edit: typed here, kept on the
// server, never shown again.
import { ref } from 'vue'
import { api, useSession } from '../stores/session'

const session = useSession()
const key = ref('')
const busy = ref(false)
const error = ref('')

async function save(value: string) {
  busy.value = true
  error.value = ''
  try {
    await api.setAssistantKey(value)
    key.value = ''
    await session.load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="card assistant-key" aria-label="Assistant" @submit.prevent="save(key.trim())">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label>
      Anthropic API key
      <input v-model="key" name="assistant-key" type="password" autocomplete="off" :required="!session.session?.assistant?.key" :placeholder="session.session?.assistant?.key ? 'kept' : ''" />
    </label>
    <div class="buttons">
      <button v-if="session.session?.assistant?.key" type="button" class="plain" :disabled="busy" @click="save('')">Remove</button>
      <button type="submit" :disabled="busy || key.trim() === ''">Save</button>
    </div>
  </form>
</template>
