<script setup lang="ts">
// A QR code of a short text, drawn as one SVG path.
import qrcode from 'qrcode-generator'
import { computed } from 'vue'

const props = defineProps<{ text: string; label: string }>()
const drawn = computed(() => {
  const qr = qrcode(0, 'M')
  qr.addData(props.text)
  qr.make()
  const n = qr.getModuleCount()
  let path = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`
  return { size: n + 8, path }
})
</script>

<template>
  <svg class="qr" :viewBox="`0 0 ${drawn.size} ${drawn.size}`" role="img" :aria-label="label" shape-rendering="crispEdges">
    <rect width="100%" height="100%" fill="#fff" />
    <path :d="drawn.path" fill="#000" />
  </svg>
</template>
