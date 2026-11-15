<script setup lang="ts">
// Installs checkd-agent on one host: over SSH by default, nuthatch logging
// in with a login given for this run alone; or a command to run there.
import type { AgentInstall, FirewallGap } from '@nuthatch/api'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../stores/session'

const props = defineProps<{ backend: string; host: string; address?: string; os?: 'linux' | 'windows' }>()
const emit = defineEmits<{ started: []; done: [ok: boolean] }>()

const os = ref<'linux' | 'windows'>(props.os ?? 'linux')
const nrpe = ref(false)
const plugins = ref(false)
const addresses = ref<string[]>([])
/** What this machine's firewall keeps out of the agent ports. */
const firewall = ref<FirewallGap[]>([])
const fixes = () => [...new Set(firewall.value.map((g) => g.command))].join('\n')
const at = ref('')
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  try {
    // The address on the host's own network first.
    const answer = await api.agents(props.backend, props.host)
    addresses.value = answer.addresses ?? []
    firewall.value = answer.firewall ?? []
    at.value = addresses.value[0] ?? ''
  } catch {
    // The server's own address, then.
  }
  // The host's key at once, for the address already known: one click less.
  if (ssh.value.address) await lookUp(true)
})

// Over SSH. The login is sent once and kept nowhere; the fields are
// emptied as soon as it is sent.
const how = ref<'ssh' | 'command'>('ssh')
const ssh = ref({ address: props.address ?? '', port: 22, user: '', login: 'password' as 'password' | 'key', password: '', key: '', passphrase: '', sudo: '' })
const hostKey = ref<{ type: string; fingerprint: string } | null>(null)
const job = ref<{ id: string; done: boolean; ok: boolean; output: string } | null>(null)
watch(() => [ssh.value.address, ssh.value.port], () => (hostKey.value = null))

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const plan = () => ({ host: props.host, os: os.value, nrpe: nrpe.value, plugins: plugins.value, address: at.value || undefined })

/** `quiet`: on opening, a host without SSH says nothing yet. */
async function lookUp(quiet = false) {
  error.value = ''
  hostKey.value = null
  const asked = `${ssh.value.address.trim()}:${ssh.value.port}`
  try {
    const { keys } = await api.sshKeys(props.backend, ssh.value.address.trim(), Number(ssh.value.port))
    // Not if the address changed meanwhile: that one's key is asked again.
    if (asked !== `${ssh.value.address.trim()}:${ssh.value.port}`) return
    // The key ssh will use: Ed25519 when there is one.
    hostKey.value = keys.find((k) => k.type === 'ssh-ed25519') ?? keys[0] ?? null
  } catch (err) {
    if (!quiet) error.value = message(err)
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
    const { job: id } = await api.installAgentOverSsh(props.backend, plan(), login)
    job.value = { id, done: false, ok: false, output: '' }
    emit('started')
    following = setInterval(async () => {
      if (!job.value) return
      try {
        const now = await api.agentJob(job.value.id)
        job.value = { id: job.value.id, ...now }
        if (now.done) {
          clearInterval(following)
          busy.value = false
          emit('done', now.ok)
        }
      } catch {
        // The next look.
      }
    }, 1000)
  } catch (err) {
    error.value = message(err)
    busy.value = false
  }
}

// A command to run on the host.
const made = ref<AgentInstall | null>(null)
const copied = ref(false)
async function make() {
  busy.value = true
  error.value = ''
  made.value = null
  try {
    made.value = await api.installAgent(props.backend, props.host, os.value, nrpe.value, plugins.value, at.value || undefined)
    emit('started')
  } catch (err) {
    error.value = message(err)
  } finally {
    busy.value = false
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
const until = () => (made.value ? new Date(made.value.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
</script>

<template>
  <div class="install-agent">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="firewall.length > 0" class="firewall" aria-label="Firewall">
      <p class="warning-text">This machine's firewall keeps agents out. Here, run:</p>
      <pre class="call"><code>{{ fixes() }}</code></pre>
      <button type="button" class="quiet" @click="copy(fixes())">{{ copied ? 'Copied' : 'Copy' }}</button>
    </section>
    <div class="agent-form">
      <fieldset class="field">
        <legend>System</legend>
        <label><input v-model="os" type="radio" value="linux" /> Linux</label>
        <label><input v-model="os" type="radio" value="windows" /> Windows</label>
      </fieldset>
      <label v-if="addresses.length > 1" class="field">
        Engine address
        <select v-model="at" name="agent-address">
          <option v-for="a in addresses" :key="a" :value="a">{{ a }}</option>
        </select>
      </label>
      <label><input v-model="plugins" type="checkbox" /> Plugins</label>
      <label v-if="os === 'linux'"><input v-model="nrpe" type="checkbox" /> NRPE</label>
    </div>

    <form v-if="how === 'ssh'" class="agent-form" aria-label="Over SSH" @submit.prevent="installOverSsh">
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
      <button v-if="!hostKey" type="button" :disabled="!ssh.address" @click="lookUp()">Look up host key</button>
      <template v-else>
        <p class="by host-key">{{ hostKey.type }} {{ hostKey.fingerprint }}</p>
        <button type="submit" :disabled="busy">Install</button>
      </template>
    </form>
    <section v-if="job && how === 'ssh'" aria-label="Install over SSH">
      <p role="status">{{ !job.done ? 'Installing…' : job.ok ? 'Installed' : 'Failed' }}</p>
      <pre class="call"><code>{{ job.output }}</code></pre>
    </section>

    <template v-if="how === 'command'">
      <button v-if="!made" type="button" :disabled="busy" @click="make">Make command</button>
      <section v-else aria-label="Install command">
        <pre class="call"><code>{{ made.command }}</code></pre>
        <p class="by">{{ os === 'linux' ? 'As root' : 'Windows PowerShell as Administrator' }} · until {{ until() }} · once</p>
        <button type="button" class="quiet" @click="copy(made.command)">{{ copied ? 'Copied' : 'Copy' }}</button>
      </section>
    </template>

    <p class="other-way">
      <button v-if="how === 'ssh'" type="button" class="plain" @click="how = 'command'">Command instead</button>
      <button v-else type="button" class="plain" @click="how = 'ssh'">Over SSH instead</button>
    </p>
  </div>
</template>

<style scoped>
.install-agent {
  display: grid;
  gap: 0.75rem;
}
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
.other-way {
  margin: 0;
}
</style>
