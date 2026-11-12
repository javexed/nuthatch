<script setup lang="ts">
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLive } from './stores/live'
import { useSession } from './stores/session'

const session = useSession()
const live = useLive()
const router = useRouter()

// The server's events are listened to while somebody is logged in.
watch(
  () => session.session !== null,
  (loggedIn) => (loggedIn ? live.start() : live.end()),
  { immediate: true },
)

async function logout() {
  await session.logout()
  await router.push({ name: 'login' })
}

const PAGES = [
  { name: 'overview', label: 'Overview' },
  { name: 'problems', label: 'Problems' },
  { name: 'hosts', label: 'Hosts' },
  { name: 'services', label: 'Services' },
  { name: 'hostgroups', label: 'Groups' },
  { name: 'history', label: 'History' },
  { name: 'availability', label: 'Availability' },
]
</script>

<template>
  <header v-if="session.session" class="bar">
    <RouterLink to="/" class="name">nuthatch</RouterLink>
    <nav class="pages" aria-label="Pages">
      <RouterLink v-for="page in PAGES" :key="page.name" :to="{ name: page.name }">{{ page.label }}</RouterLink>
      <RouterLink v-if="session.session.config_backends.length > 0" :to="{ name: 'config' }">Config</RouterLink>
    </nav>
    <span class="who">{{ session.session.user }}</span>
    <button type="button" class="plain" @click="logout">Log out</button>
  </header>
  <main>
    <RouterView :key="$route.path" />
  </main>
</template>
