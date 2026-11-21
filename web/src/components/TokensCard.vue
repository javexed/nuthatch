<script setup lang="ts">
// API tokens: for scripts, the app, and MCP clients. A token's secret is
// shown once, when it is made. Read-only tokens read the engines and
// nothing else.
import type { Token } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { onMounted, ref } from 'vue'
import { ago } from '../lib/format'
import { api, useSession } from '../stores/session'

const session = useSession()
const tokens = ref<Token[]>([])
const name = ref('')
const readOnly = ref(true)
const made = ref<string | null>(null)
const busy = ref(false)
const error = ref('')

function fail(err: unknown) {
  error.value = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Server unreachable'
}

async function load() {
  try {
    tokens.value = await api.tokens()
  } catch (err) {
    fail(err)
  }
}
onMounted(load)

async function make() {
  busy.value = true
  error.value = ''
  try {
    made.value = (await api.newToken(name.value.trim(), readOnly.value)).token
    name.value = ''
    await load()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}

async function remove(t: Token) {
  busy.value = true
  error.value = ''
  try {
    await api.deleteToken(t.id)
    await load()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="card device" aria-label="Tokens">
    <h2>Tokens</h2>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="made" class="made" role="status">
      <code>{{ made }}</code>
      <button type="button" class="plain" @click="made = null">Done</button>
    </div>
    <ul v-if="tokens.length > 0" class="devices">
      <li v-for="t in tokens" :key="t.id">
        <span>
          <strong>{{ t.name || 'unnamed' }}</strong><template v-if="t.read_only"> · read-only</template>
          <span class="by"> · {{ t.last_used ? `used ${ago(t.last_used)}` : `made ${ago(t.created)}` }}</span>
        </span>
        <button type="button" class="plain" :disabled="busy" @click="remove(t)">Delete</button>
      </li>
    </ul>
    <form v-if="session.session?.csrf" class="make-token" @submit.prevent="make">
      <input v-model="name" name="token-name" aria-label="Token name" placeholder="Name" maxlength="64" required />
      <label class="check"><input v-model="readOnly" type="checkbox" name="token-read-only" /> Read-only</label>
      <button type="submit" :disabled="busy || name.trim() === ''">Make</button>
    </form>
  </section>
</template>
