<script setup lang="ts">
// What else is to know about an object at a glance.
defineProps<{ row: Record<string, unknown> }>()
</script>

<template>
  <span class="marks">
    <span v-if="row.acknowledged" class="mark" title="The problem is acknowledged">ack</span>
    <span v-if="Number(row.scheduled_downtime_depth) > 0" class="mark" title="In a scheduled downtime">downtime</span>
    <span v-if="row.is_flapping" class="mark" title="Changing state too often">flapping</span>
    <span v-if="row.notifications_enabled === 0" class="mark off" title="Notifications are off">no notif.</span>
    <span v-if="row.active_checks_enabled === 0" class="mark off" title="Active checks are off">no checks</span>
  </span>
</template>
