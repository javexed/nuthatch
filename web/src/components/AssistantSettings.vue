<script setup lang="ts">
// The assistant's settings, for config_edit: which service it asks, where,
// which model, and the key. The key is kept on the server, never shown
// again.
import type { AssistantService, AssistantSettings } from '@nuthatch/api'
import { computed, onMounted, ref, watch } from 'vue'
import { api, useSession } from '../stores/session'

const session = useSession()
const NAMES: Record<AssistantService, string> = { anthropic: 'Anthropic', ollama: 'Ollama', openai: 'OpenAI-compatible' }
const ADDRESS: Record<AssistantService, string> = {
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const saved = ref<AssistantSettings | null>(null)
const service = ref<AssistantService>('anthropic')
const url = ref('')
const model = ref('')
const effort = ref<AssistantSettings['effort']>('medium')
const context = ref(16384)
const key = ref('')
const models = ref<string[]>([])
const busy = ref(false)
const error = ref('')

/** The kept key still goes with what the form shows. */
const keyKept = computed(() => {
  const s = saved.value
  return !!s?.key && s.service === service.value && s.url === (url.value.trim().replace(/\/+$/, '') || ADDRESS[service.value])
})

function show(s: AssistantSettings) {
  saved.value = s
  service.value = s.service
  url.value = s.url === ADDRESS[s.service] ? '' : s.url
  model.value = s.model
  effort.value = s.effort
  context.value = s.context
  key.value = ''
}

async function list() {
  try {
    models.value = (await api.assistantModels(service.value, url.value.trim(), key.value.trim() || undefined)).models
  } catch {
    models.value = []
  }
}

async function save(removeKey = false) {
  busy.value = true
  error.value = ''
  try {
    const typed = key.value.trim()
    show(
      await api.setAssistantSettings({
        service: service.value,
        url: url.value.trim(),
        model: model.value.trim(),
        effort: effort.value,
        context: context.value,
        ...(removeKey ? { key: '' } : typed !== '' ? { key: typed } : {}),
      }),
    )
    await session.load()
    void list()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    show(await api.assistantSettings())
    void list()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
})

watch(service, (now, before) => {
  if (saved.value === null || now === before) return
  url.value = ''
  model.value = now === saved.value.service ? saved.value.model : ''
  void list()
})
</script>

<template>
  <form class="card assistant-key" aria-label="Assistant" @submit.prevent="save()">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label>
      Service
      <select v-model="service" name="assistant-service" :disabled="busy">
        <option v-for="(name, s) in NAMES" :key="s" :value="s">{{ name }}</option>
      </select>
    </label>
    <label>
      Address
      <input v-model="url" name="assistant-url" type="url" autocomplete="off" :placeholder="ADDRESS[service]" @change="list" />
    </label>
    <label>
      Model
      <input v-model="model" name="assistant-model" autocomplete="off" required list="assistant-models" @focus="models.length === 0 && list()" />
      <datalist id="assistant-models">
        <option v-for="m in models" :key="m" :value="m" />
      </datalist>
    </label>
    <label v-if="service === 'anthropic'">
      Effort
      <select v-model="effort" name="assistant-effort">
        <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
      </select>
    </label>
    <label v-if="service === 'ollama'">
      Context
      <input v-model.number="context" name="assistant-context" type="number" min="2048" max="262144" step="1024" required />
    </label>
    <label>
      API key
      <input v-model="key" name="assistant-key" type="password" autocomplete="off" :required="service === 'anthropic' && !keyKept" :placeholder="keyKept ? 'kept' : ''" @change="list" />
    </label>
    <div class="buttons">
      <button v-if="keyKept" type="button" class="plain" :disabled="busy" @click="save(true)">Remove key</button>
      <button type="submit" :disabled="busy || model.trim() === ''">Save</button>
    </div>
  </form>
</template>
