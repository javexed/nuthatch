<script setup lang="ts">
// Text as it was written, with its web addresses as links. No HTML of the
// text is ever made into markup.
import { computed } from 'vue'

const props = defineProps<{ text: string }>()
const lines = computed(() =>
  props.text.split('\n').map((line) =>
    line.split(/(https?:\/\/[^\s<>"']+)/).map((part, n) => ({ part, link: n % 2 === 1 })),
  ),
)
</script>

<template>
  <div class="note">
    <p v-for="(line, i) in lines" :key="i">
      <template v-for="(bit, j) in line" :key="j">
        <a v-if="bit.link" :href="bit.part" target="_blank" rel="noopener noreferrer">{{ bit.part }}</a>
        <template v-else>{{ bit.part }}</template>
      </template>
    </p>
  </div>
</template>
