<script setup lang="ts">
// The key that signs the agent binaries, for config_edit: made here or
// uploaded, and the binaries signed with it. Agents installed while there
// is a key take only binaries it signed.
import type { AgentSigning } from '@nuthatch/api'
import { computed, onMounted, ref } from 'vue'
import { api } from '../stores/session'

const state = ref<AgentSigning | null>(null)
const choosing = ref(false)
const uploading = ref(false)
const cert = ref('')
const key = ref('')
const busy = ref(false)
const error = ref('')

async function run(work: () => Promise<AgentSigning>) {
  busy.value = true
  error.value = ''
  try {
    state.value = await work()
    choosing.value = false
    uploading.value = false
    cert.value = ''
    key.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => run(() => api.agentSigning()))

const LOSE = 'Agents installed with the key there is now take no updates until they are installed again.'
function make() {
  if (state.value?.signer && !confirm(LOSE)) return
  void run(() => api.setAgentSigningKey({ make: true }))
}
function upload() {
  if (state.value?.signer && !confirm(LOSE)) return
  void run(() => api.setAgentSigningKey({ cert: cert.value, key: key.value }))
}
function remove() {
  if (!confirm(LOSE)) return
  void run(() => api.removeAgentSigningKey())
}
async function read(event: Event, into: 'cert' | 'key') {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) (into === 'cert' ? cert : key).value = await file.text()
}

const day = (ms: number) => new Date(ms).toLocaleDateString()
const id = computed(() => state.value?.signer?.id.slice(0, 16).replace(/(.{4})(?!$)/g, '$1 ') ?? '')
</script>

<template>
  <section class="card agent-signing" aria-label="Agent signing">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="state">
      <template v-if="state.signer">
        <p>
          <strong>{{ state.signer.subject }}</strong>
          <span class="by"> · {{ state.signer.algorithm }} · {{ id }} · {{ state.signer.self_signed ? 'self-signed' : `until ${day(state.signer.until)}` }}</span>
        </p>
        <p v-if="state.current && state.signed" class="by">Signed{{ state.signed.version ? ` ${state.signed.version}` : '' }} · {{ day(state.signed.at) }}</p>
        <p v-else-if="state.unsigned.length > 0" class="warning-text">Not signed: {{ state.unsigned.join(', ') }}</p>
        <div class="buttons">
          <button type="button" class="plain" :disabled="busy" @click="remove">Remove</button>
          <button type="button" class="quiet" :disabled="busy" :aria-pressed="choosing" @click="choosing = !choosing">Replace</button>
          <button v-if="state.unsigned.length > 0" type="button" :disabled="busy" @click="run(() => api.signAgents())">Sign</button>
        </div>
      </template>
      <div v-if="!state.signer || choosing" class="buttons">
        <button type="button" class="quiet" :disabled="busy" :aria-pressed="uploading" @click="uploading = !uploading">Upload</button>
        <button type="button" :disabled="busy" @click="make">Make a key</button>
      </div>
      <form v-if="uploading" aria-label="Upload a signing key" @submit.prevent="upload">
        <label>
          Certificate
          <textarea v-model="cert" name="signing-cert" rows="4" required spellcheck="false"></textarea>
          <input type="file" accept=".pem,.crt,.cer" aria-label="Certificate file" @change="read($event, 'cert')" />
        </label>
        <label>
          Private key
          <textarea v-model="key" name="signing-key" rows="4" required spellcheck="false"></textarea>
          <input type="file" accept=".pem,.key" aria-label="Private key file" @change="read($event, 'key')" />
        </label>
        <div class="buttons">
          <button type="submit" :disabled="busy || cert.trim() === '' || key.trim() === ''">Save</button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.agent-signing {
  display: grid;
  gap: 0.5rem;
}
.agent-signing p {
  margin: 0;
}
.agent-signing form {
  display: grid;
  gap: 0.5rem;
}
.agent-signing textarea {
  font-family: var(--mono, monospace);
  font-size: 0.8rem;
}
</style>
