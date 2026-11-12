<script setup lang="ts">
// Choosing a span of time: a ready-made one, or two moments.
import { ref, watch } from 'vue'
import { RANGES, type Span } from '../lib/availability'
import { fromInput, toInput } from '../lib/format'

const props = defineProps<{ id: string; span: Span }>()
const emit = defineEmits<{ range: [id: string]; custom: [span: Span] }>()
const from = ref(toInput(props.span.from))
const to = ref(toInput(props.span.to))
const problem = ref('')
watch(() => props.span, (span) => {
  from.value = toInput(span.from)
  to.value = toInput(span.to)
})

function choose(id: string) {
  problem.value = ''
  if (id !== 'custom') emit('range', id)
  else emit('custom', { from: Math.floor(props.span.from), to: Math.floor(props.span.to) })
}

function apply() {
  const span = { from: fromInput(from.value), to: fromInput(to.value) }
  if (!Number.isFinite(span.from) || !Number.isFinite(span.to) || span.to <= span.from) {
    problem.value = 'The end must be after the start.'
    return
  }
  problem.value = ''
  emit('custom', span)
}
</script>

<template>
  <div class="range">
    <label>
      Time
      <select :value="id" name="range" @change="choose(($event.target as HTMLSelectElement).value)">
        <option v-for="range in RANGES" :key="range.id" :value="range.id">{{ range.label }}</option>
        <option value="custom">From … to …</option>
      </select>
    </label>
    <form v-if="id === 'custom'" class="custom" @submit.prevent="apply">
      <label>From <input v-model="from" name="from" type="datetime-local" required /></label>
      <label>To <input v-model="to" name="to" type="datetime-local" required /></label>
      <button type="submit" class="quiet">Show</button>
    </form>
    <p v-if="problem" class="error" role="alert">{{ problem }}</p>
  </div>
</template>
