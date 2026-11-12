<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useSession } from './stores/session'

const session = useSession()
const router = useRouter()

async function logout() {
  await session.logout()
  await router.push({ name: 'login' })
}
</script>

<template>
  <header v-if="session.session" class="bar">
    <RouterLink to="/" class="name">nuthatch</RouterLink>
    <span class="who">{{ session.session.user }}</span>
    <button type="button" class="plain" @click="logout">Log out</button>
  </header>
  <main>
    <RouterView />
  </main>
</template>
