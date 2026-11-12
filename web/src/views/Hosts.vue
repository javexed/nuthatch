<script setup lang="ts">
import StatusList from '../components/StatusList.vue'
</script>

<template>
  <h1>Hosts</h1>
  <StatusList kind="host" controls empty="No host matches." />
</template>
