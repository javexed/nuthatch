<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BottomBar from './components/BottomBar.vue'
import ConnectionDot from './components/ConnectionDot.vue'
import { pulled } from './lib/gestures'
import { updateReady, watchForUpdates } from './lib/update'
import { useLive } from './stores/live'
import { useSession } from './stores/session'

const session = useSession()
const live = useLive()
const router = useRouter()
const route = useRoute()

// The server's events are listened to while somebody is logged in.
watch(
  () => session.session !== null,
  (loggedIn) => (loggedIn ? live.start() : live.end()),
  { immediate: true },
)

// A newer build reloads the page when it comes back from the background,
// unless something may be half typed: the config page, or a dialog open.
onMounted(() => watchForUpdates(() => route.name !== 'config' && document.querySelector('dialog[open]') === null))

function reload() {
  location.reload()
}

// On a touch screen, a pull down from the top of the page asks the
// server anew for what the page shows (the browser's own pull, which
// would load the whole page again, is turned off in style.css).
const pull = ref<{ y: number; dy: number } | null>(null)
const refreshed = ref(false)
const pullAmount = computed(() => (pull.value ? pulled(pull.value.dy) : 0))
function pullStart(event: TouchEvent) {
  const [finger] = event.touches
  const top = (document.scrollingElement?.scrollTop ?? 0) <= 0
  pull.value = top && event.touches.length === 1 && finger && session.session && !document.querySelector('dialog[open]') ? { y: finger.clientY, dy: 0 } : null
}
function pullMove(event: TouchEvent) {
  const [finger] = event.touches
  if (pull.value && finger) pull.value.dy = finger.clientY - pull.value.y
}
function pullEnd() {
  const enough = pullAmount.value >= 1
  pull.value = null
  if (!enough) return
  live.version++
  refreshed.value = true
  setTimeout(() => (refreshed.value = false), 900)
}

async function logout() {
  await session.logout()
  await router.push({ name: 'login' })
}

const PAGES = [
  { name: 'overview', label: 'Overview' },
  { name: 'dashboards', label: 'Dashboards' },
  { name: 'problems', label: 'Problems' },
  { name: 'hosts', label: 'Hosts' },
  { name: 'services', label: 'Services' },
  { name: 'hostgroups', label: 'Groups' },
  { name: 'history', label: 'History' },
  { name: 'availability', label: 'Availability' },
]
/** What the bottom bar keeps under More. */
const MORE = computed(() => [
  { name: 'dashboards', label: 'Dashboards' },
  { name: 'hostgroups', label: 'Groups' },
  { name: 'history', label: 'History' },
  { name: 'availability', label: 'Availability' },
  ...(session.session && session.session.config_backends.length > 0 ? [{ name: 'config', label: 'Config' }] : []),
  { name: 'device', label: 'This device' },
])
const logo = `${import.meta.env.BASE_URL}favicon.svg`
</script>

<template>
  <header v-if="session.session" class="bar">
    <RouterLink to="/" class="name"><img :src="logo" alt="" width="28" height="28" />nuthatch</RouterLink>
    <nav class="pages" aria-label="Pages">
      <RouterLink v-for="page in PAGES" :key="page.name" :to="{ name: page.name }">{{ page.label }}</RouterLink>
      <RouterLink v-if="session.session.config_backends.length > 0" :to="{ name: 'config' }">Config</RouterLink>
    </nav>
    <ConnectionDot />
    <RouterLink :to="{ name: 'device' }" class="who" title="This device: notifications">{{ session.session.user }}</RouterLink>
    <button v-if="!session.session.by_tailnet" type="button" class="plain logout" @click="logout">Log out</button>
  </header>
  <div v-if="updateReady" class="update" role="status">
    A new version of nuthatch is ready.
    <button type="button" @click="reload">Reload</button>
  </div>
  <div v-if="pullAmount > 0 || refreshed" class="pull" :class="{ ready: pullAmount >= 1, done: refreshed }" :style="{ height: `${refreshed ? 2.2 : pullAmount * 3}rem` }" aria-hidden="true">
    <span class="spinner" :style="refreshed ? undefined : { animation: 'none', transform: `rotate(${pullAmount * 300}deg)` }"></span>
    {{ refreshed ? 'Refreshing…' : pullAmount >= 1 ? 'Let go to refresh' : 'Pull to refresh' }}
  </div>
  <main :class="{ 'with-tabbar': session.session }" @touchstart.passive="pullStart" @touchmove.passive="pullMove" @touchend.passive="pullEnd" @touchcancel.passive="pull = null">
    <RouterView :key="$route.path" />
  </main>
  <BottomBar v-if="session.session" :more="MORE" @logout="logout" />
</template>
