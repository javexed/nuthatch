<script setup lang="ts">
// The few line icons of the bottom bar, drawn here.
defineProps<{ name: 'overview' | 'problems' | 'hosts' | 'services' | 'more' }>()
</script>

<template>
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'overview'">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </template>
    <template v-else-if="name === 'problems'">
      <path d="M12 3.5 21 19.5H3Z" /><path d="M12 10v4" /><path d="M12 16.8v.2" />
    </template>
    <template v-else-if="name === 'hosts'">
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
      <path d="M7 7.25h.01M7 16.75h.01" />
    </template>
    <template v-else-if="name === 'services'">
      <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" /><path d="M4 6.5h.01M4 12h.01M4 17.5h.01" />
    </template>
    <template v-else>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </template>
  </svg>
</template>
