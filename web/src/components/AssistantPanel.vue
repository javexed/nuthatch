<script setup lang="ts">
// The assistant: a button that opens a chat beside the page. Shown only
// where the server says it is ready for this user.
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { type About, useAssistant } from '../stores/assistant'
import Icon from './Icon.vue'

const assistant = useAssistant()
const route = useRoute()
const question = ref('')
const list = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)

/** The host or service of the page, when it shows one. */
const about = computed<About | undefined>(() => {
  const p = route.params as Record<string, string | undefined>
  if ((route.name === 'host' || route.name === 'service') && p.backend && p.host) {
    return { backend: p.backend, host: p.host, ...(p.service ? { service: p.service } : {}) }
  }
  return undefined
})

function send() {
  const text = question.value
  question.value = ''
  void assistant.ask(text, about.value)
}
function key(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}

// The newest text stays in sight while it is written.
watch(
  () => {
    const last = assistant.turns[assistant.turns.length - 1]
    return [assistant.turns.length, last?.text.length, last?.looked.length]
  },
  async () => {
    await nextTick()
    list.value?.scrollTo({ top: list.value.scrollHeight })
  },
)
watch(
  () => assistant.open,
  async (open) => {
    if (!open) return
    await nextTick()
    input.value?.focus()
  },
)
</script>

<template>
  <button v-if="!assistant.open" type="button" class="assistant-open" aria-label="Assistant" title="Assistant" @click="assistant.open = true">
    <Icon name="chat" />
  </button>
  <aside v-else class="assistant" aria-label="Assistant">
    <header>
      <strong>Assistant</strong>
      <span v-if="about" class="by">{{ about.service ?? about.host }}</span>
      <button v-if="assistant.turns.length > 0" type="button" class="plain" :disabled="assistant.busy" @click="assistant.clear()">Clear</button>
      <button type="button" class="plain" aria-label="Close" @click="assistant.open = false">✕</button>
    </header>
    <ol ref="list" class="turns" aria-live="polite">
      <li v-for="(t, n) in assistant.turns" :key="n" :class="`turn-${t.role}`">
        <ul v-if="t.looked.length > 0" class="looked">
          <li v-for="(l, i) in t.looked" :key="i">{{ l }}</li>
        </ul>
        <p v-if="t.text" class="text">{{ t.text }}</p>
        <p v-else-if="t.role === 'assistant' && !t.failed && assistant.busy && n === assistant.turns.length - 1" class="by">…</p>
        <p v-if="t.failed" class="error" role="alert">{{ t.failed }}</p>
      </li>
    </ol>
    <form @submit.prevent="send">
      <textarea ref="input" v-model="question" name="question" rows="2" maxlength="20000" aria-label="Question" @keydown="key"></textarea>
      <button v-if="assistant.busy" type="button" class="quiet" @click="assistant.stop()">Stop</button>
      <button v-else type="submit" :disabled="question.trim() === ''">Ask</button>
    </form>
  </aside>
</template>
