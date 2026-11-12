<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ offset: number; limit: number; total: number }>()
const emit = defineEmits<{ go: [offset: number] }>()
const last = computed(() => Math.min(props.offset + props.limit, props.total))
</script>

<template>
  <nav v-if="total > limit" class="pager" aria-label="Pages">
    <button type="button" class="quiet" :disabled="offset === 0" @click="emit('go', Math.max(0, offset - limit))">Previous</button>
    <span>{{ offset + 1 }}–{{ last }} of {{ total }}</span>
    <button type="button" class="quiet" :disabled="last >= total" @click="emit('go', offset + limit)">Next</button>
  </nav>
  <p v-else class="count">{{ total }} {{ total === 1 ? 'row' : 'rows' }}</p>
</template>
