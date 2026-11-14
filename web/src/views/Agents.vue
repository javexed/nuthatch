<script setup lang="ts">
// checkd-agent on monitored hosts: the command that installs one, and
// the agents there are.
import type { AgentInstall, AgentRow } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { api, useSession } from '../stores/session'

const session = useSession()
const backends = computed(() => session.session?.agent_backends ?? [])
const backend = ref(backends.value[0] ?? '')
const agents = ref<AgentRow[] | null>(null)
const hosts = ref<string[]>([])
const error = ref('')

const addresses = ref<string[]>([])
const address = ref('')
const host = ref('')
const os = ref<'linux' | 'windows'>('linux')
const nrpe = ref(false)
const plugins = ref(true)
const made = ref<AgentInstall | null>(null)
const busy = ref(false)
const copied = ref(false)

async function load() {
  if (!backend.value) return
  error.value = ''
  try {
    const [list, found] = await Promise.all([
      api.agents(backend.value),
      api.query({ table: 'hosts', columns: ['name'], sort: [{ column: 'name' }], backends: [backend.value] }),
    ])
    agents.value = list.agents
    addresses.value = list.addresses ?? []
    if (!addresses.value.includes(address.value)) address.value = addresses.value[0] ?? ''
    hosts.value = found.rows.map((r) => String(r.name)).filter((name) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
watch(backend, load, { immediate: true })

async function make() {
  busy.value = true
  error.value = ''
  made.value = null
  try {
    made.value = await api.installAgent(backend.value, host.value, os.value, nrpe.value, plugins.value, address.value || undefined)
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function remove(name: string) {
  if (!confirm(`Remove the agent of ${name}?`)) return
  try {
    await api.removeAgent(backend.value, name)
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    // Copied by hand.
  }
}

const until = computed(() => (made.value ? new Date(made.value.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''))
</script>

<template>
  <h1>Agents</h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <label v-if="backends.length > 1" class="field">
    Backend
    <select v-model="backend">
      <option v-for="b in backends" :key="b" :value="b">{{ b }}</option>
    </select>
  </label>

  <form class="card agent-form" @submit.prevent="make">
    <label class="field">
      Host
      <select v-model="host" required>
        <option value="" disabled>Choose</option>
        <option v-for="h in hosts" :key="h" :value="h">{{ h }}</option>
      </select>
    </label>
    <fieldset class="field">
      <legend>System</legend>
      <label><input v-model="os" type="radio" value="linux" /> Linux</label>
      <label><input v-model="os" type="radio" value="windows" /> Windows</label>
    </fieldset>
    <label v-if="addresses.length > 1" class="field">
      Address
      <select v-model="address">
        <option v-for="a in addresses" :key="a" :value="a">{{ a }}</option>
      </select>
    </label>
    <label><input v-model="plugins" type="checkbox" /> Plugins only</label>
    <label v-if="os === 'linux'"><input v-model="nrpe" type="checkbox" /> NRPE</label>
    <button type="submit" :disabled="busy || !host">Make command</button>
  </form>

  <section v-if="made" class="card" aria-label="Install command">
    <pre class="call"><code>{{ made.command }}</code></pre>
    <p class="by">{{ os === 'linux' ? 'As root' : 'Windows PowerShell as Administrator' }} · until {{ until }} · once</p>
    <button type="button" class="quiet" @click="copy(made.command)">{{ copied ? 'Copied' : 'Copy' }}</button>
  </section>

  <p v-if="agents && agents.length === 0" class="none">None</p>
  <table v-else-if="agents" class="rows">
    <thead>
      <tr><th>Host</th><th>Connected</th><th></th></tr>
    </thead>
    <tbody>
      <tr v-for="a in agents" :key="a.host">
        <td><RouterLink :to="{ name: 'host', params: { backend, host: a.host } }">{{ a.host }}</RouterLink></td>
        <td>{{ a.connected ? 'Yes' : a.waiting ? 'Waiting' : a.connected === undefined ? '–' : 'No' }}</td>
        <td><button type="button" class="quiet" @click="remove(a.host)">Remove</button></td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.agent-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  align-items: end;
}
.call {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
fieldset.field {
  border: 0;
  padding: 0;
  margin: 0;
  display: flex;
  gap: 0.75rem;
}
</style>
