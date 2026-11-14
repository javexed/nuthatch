<script setup lang="ts">
// checkd-agent on monitored hosts: the command that installs one, and
// the agents there are.
import type { AgentInstall, AgentRow } from '@nuthatch/api'
import { computed, onUnmounted, ref, watch } from 'vue'
import { api, useSession } from '../stores/session'

const session = useSession()
const backends = computed(() => session.session?.agent_backends ?? [])
const backend = ref(backends.value[0] ?? '')
const agents = ref<AgentRow[] | null>(null)
const hosts = ref<string[]>([])
/** Each host's address, for SSH. */
const hostAddress = ref(new Map<string, string>())
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
      api.query({ table: 'hosts', columns: ['name', 'address'], sort: [{ column: 'name' }], backends: [backend.value] }),
    ])
    agents.value = list.agents
    addresses.value = list.addresses ?? []
    if (!addresses.value.includes(address.value)) address.value = addresses.value[0] ?? ''
    hosts.value = found.rows.map((r) => String(r.name)).filter((name) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name))
    hostAddress.value = new Map(found.rows.map((r) => [String(r.name), String(r.address ?? '')]))
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

// Over SSH: nuthatch logs in and installs. The login is sent once and
// kept nowhere; the fields are emptied as soon as it is sent.
const how = ref<'command' | 'ssh'>('command')
const ssh = ref({ address: '', port: 22, user: '', login: 'password' as 'password' | 'key', password: '', key: '', passphrase: '', sudo: '' })
const hostKey = ref<{ type: string; fingerprint: string } | null>(null)
const job = ref<{ id: string; done: boolean; ok: boolean; output: string } | null>(null)
watch(host, (name) => {
  ssh.value.address = hostAddress.value.get(name) ?? ''
  hostKey.value = null
})
watch(() => [ssh.value.address, ssh.value.port], () => (hostKey.value = null))

async function lookUp() {
  error.value = ''
  hostKey.value = null
  try {
    const { keys } = await api.sshKeys(backend.value, ssh.value.address.trim(), Number(ssh.value.port))
    // The key ssh will use: Ed25519 when there is one.
    hostKey.value = keys.find((k) => k.type === 'ssh-ed25519') ?? keys[0] ?? null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

let following: ReturnType<typeof setInterval> | undefined
onUnmounted(() => clearInterval(following))
async function installOverSsh() {
  if (!hostKey.value) return
  busy.value = true
  error.value = ''
  job.value = null
  clearInterval(following)
  const s = ssh.value
  const login = {
    address: s.address.trim(),
    port: Number(s.port),
    user: s.user.trim(),
    fingerprint: hostKey.value.fingerprint,
    ...(s.login === 'password' ? { password: s.password } : { key: s.key, ...(s.passphrase ? { passphrase: s.passphrase } : {}) }),
    ...(s.sudo ? { sudo_password: s.sudo } : {}),
  }
  s.password = ''
  s.key = ''
  s.passphrase = ''
  s.sudo = ''
  try {
    const { job: id } = await api.installAgentOverSsh(backend.value, { host: host.value, os: os.value, nrpe: nrpe.value, plugins: plugins.value, address: address.value || undefined }, login)
    job.value = { id, done: false, ok: false, output: '' }
    clearInterval(following)
    following = setInterval(async () => {
      if (!job.value) return
      try {
        const now = await api.agentJob(job.value.id)
        job.value = { id: job.value.id, ...now }
        if (now.done) {
          clearInterval(following)
          busy.value = false
          await load()
        }
      } catch {
        // The next look.
      }
    }, 1000)
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
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
    <fieldset class="field">
      <legend>Install</legend>
      <label><input v-model="how" type="radio" value="command" /> Command</label>
      <label><input v-model="how" type="radio" value="ssh" /> Over SSH</label>
    </fieldset>
    <button v-if="how === 'command'" type="submit" :disabled="busy || !host">Make command</button>
  </form>

  <form v-if="how === 'ssh'" class="card agent-form" aria-label="Over SSH" @submit.prevent="installOverSsh">
    <label class="field">SSH address <input v-model="ssh.address" name="ssh-address" required autocapitalize="none" /></label>
    <label class="field">Port <input v-model.number="ssh.port" name="ssh-port" type="number" min="1" max="65535" class="port" /></label>
    <label class="field">User <input v-model="ssh.user" name="ssh-user" required autocapitalize="none" autocomplete="off" /></label>
    <fieldset class="field">
      <legend>Login</legend>
      <label><input v-model="ssh.login" type="radio" value="password" /> Password</label>
      <label><input v-model="ssh.login" type="radio" value="key" /> Key</label>
    </fieldset>
    <label v-if="ssh.login === 'password'" class="field">Password <input v-model="ssh.password" name="ssh-password" type="password" required autocomplete="off" /></label>
    <template v-else>
      <label class="field wide">Private key <textarea v-model="ssh.key" name="ssh-key" required rows="4" spellcheck="false" autocomplete="off"></textarea></label>
      <label class="field">Passphrase <input v-model="ssh.passphrase" name="ssh-passphrase" type="password" autocomplete="off" /></label>
    </template>
    <label v-if="os === 'linux' && ssh.user !== 'root' && ssh.login === 'key'" class="field">sudo password <input v-model="ssh.sudo" name="ssh-sudo" type="password" autocomplete="off" /></label>
    <button v-if="!hostKey" type="button" :disabled="!host || !ssh.address" @click="lookUp">Look up host key</button>
    <template v-else>
      <p class="by host-key">{{ hostKey.type }} {{ hostKey.fingerprint }}</p>
      <button type="submit" :disabled="busy">Install</button>
    </template>
  </form>

  <section v-if="job && how === 'ssh'" class="card" aria-label="Install over SSH">
    <p role="status">{{ !job.done ? 'Installing…' : job.ok ? 'Done' : 'Failed' }}</p>
    <pre class="call"><code>{{ job.output }}</code></pre>
  </section>

  <section v-if="made && how === 'command'" class="card" aria-label="Install command">
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
.agent-form .wide {
  flex-basis: 100%;
}
.agent-form textarea {
  width: 100%;
  font-family: monospace;
}
.port {
  width: 6rem;
}
.host-key {
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
