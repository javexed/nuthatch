<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@nuthatch/api'
import { APP, lastServer, useSession } from '../stores/session'

const session = useSession()
const route = useRoute()
const router = useRouter()
const server = ref(lastServer())
const user = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await session.login(user.value, password.value, server.value)
    const to = typeof route.query.to === 'string' && route.query.to.startsWith('/') ? route.query.to : '/'
    await router.push(to)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : APP ? 'The server cannot be reached, or does not let this app in.' : 'The server cannot be reached.'
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="login card" @submit.prevent="submit">
    <h1>nuthatch</h1>
    <label v-if="APP">
      Server
      <input v-model="server" name="server" inputmode="url" autocapitalize="none" autocomplete="url" placeholder="monitoring.example.org" required />
    </label>
    <label>
      User
      <input v-model="user" name="username" autocomplete="username" autocapitalize="none" required autofocus />
    </label>
    <label>
      Password
      <input v-model="password" name="password" type="password" autocomplete="current-password" required />
    </label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button type="submit" :disabled="busy">Log in</button>
  </form>
</template>
