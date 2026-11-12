<script setup lang="ts">
import { computed } from 'vue'
import { type Kind, stateOf } from '../lib/states'

const props = defineProps<{ kind: Kind; state: unknown; checked?: unknown }>()
const state = computed(() => stateOf(props.kind, props.state, props.checked ?? 1))
</script>

<template>
  <span :class="['badge', state.tone]">{{ state.label }}</span>
</template>
