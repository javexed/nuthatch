<script setup lang="ts">
// The bar at the bottom of a narrow screen: the pages used most, one tap
// away, with the number of open problems; the rest under More.
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useProblemCount } from '../stores/problems'
import { useSession } from '../stores/session'

defineProps<{ more: { name: string; label: string }[] }>()
const emit = defineEmits<{ logout: [] }>()

const session = useSession()
const problems = useProblemCount()
const sheet = ref<HTMLDialogElement | null>(null)
const route = useRoute()

const TABS = [
  { name: 'overview', label: 'Overview', icon: 'overview' },
  { name: 'problems', label: 'Problems', icon: 'problems' },
  { name: 'hosts', label: 'Hosts', icon: 'hosts' },
  { name: 'services', label: 'Services', icon: 'services' },
] as const

function open() {
  sheet.value?.showModal()
}
function close() {
  sheet.value?.close()
}
// Going to a page closes the sheet.
watch(() => route.fullPath, close)
</script>

<template>
  <nav class="tabbar" aria-label="Main pages">
    <RouterLink
      v-for="tab in TABS"
      :key="tab.name"
      :to="{ name: tab.name }"
      class="tab"
      :aria-label="tab.name === 'problems' && problems.total.value > 0 ? `${tab.label}, ${problems.total.value} open` : undefined"
    >
      <span class="icon"><Icon :name="tab.icon" /><span v-if="tab.name === 'problems' && problems.total.value > 0" class="badge" aria-hidden="true">{{ problems.total.value > 99 ? '99+' : problems.total.value }}</span></span>
      <span class="label">{{ tab.label }}</span>
    </RouterLink>
    <button type="button" class="tab" aria-haspopup="dialog" @click="open">
      <span class="icon"><Icon name="more" /></span>
      <span class="label">More</span>
    </button>
  </nav>
  <dialog ref="sheet" class="sheet" aria-label="More" @click.self="close">
    <div class="sheet-body">
      <nav aria-label="More pages">
        <RouterLink v-for="page in more" :key="page.name" :to="{ name: page.name }">{{ page.label }}</RouterLink>
      </nav>
      <div class="sheet-foot">
        <span v-if="session.session?.by_tailnet" class="who">Signed in by Tailscale as <strong>{{ session.session.user }}</strong></span>
        <template v-else>
          <span class="who">Logged in as <strong>{{ session.session?.user }}</strong></span>
          <button type="button" @click="emit('logout')">Log out</button>
        </template>
      </div>
      <button type="button" class="plain" @click="close">Close</button>
    </div>
  </dialog>
</template>
