<script setup lang="ts">
// A host's agent: installing one, and once it has said what its machine
// is, the checks added from that and those proposed.
import type { AgentRow, HostInventory } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useLive } from '../stores/live'
import { api } from '../stores/session'
import InstallAgent from './InstallAgent.vue'

const props = defineProps<{ backend: string; host: string; address?: string; os?: 'linux' | 'windows'; install?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const live = useLive()

const agent = ref<AgentRow | null>(null)
const inventory = ref<HostInventory | null>(null)
const loaded = ref(false)
const installing = ref(props.install === true)
/** Installing over the agent the host has, which goes on until the new one connects. */
const again = ref(false)
function installAgain(on: boolean) {
  again.value = on
  installing.value = on
}
const ticked = ref<Record<string, boolean>>({})
const busy = ref(false)
const error = ref('')
const added = ref<string[]>([])
const now = ref(Date.now())

async function load() {
  try {
    const answer = await api.inventory(props.backend, props.host)
    now.value = Date.now()
    agent.value = answer.agent
    const before = inventory.value
    inventory.value = answer.inventory
    for (const p of answer.inventory?.proposals ?? []) if (!(p.key in ticked.value)) ticked.value[p.key] = p.checked
    // The base checks were added just now: the lists show them.
    if (!before && answer.inventory && answer.inventory.base.length > 0) {
      live.nudge()
      emit('changed')
    }
    if (answer.agent && !answer.agent.waiting && !again.value) installing.value = false
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    loaded.value = true
  }
}

// Often while an agent is on its way; seldom once it has said what it is.
let timer: ReturnType<typeof setTimeout> | undefined
// Gone: a look still on its way when the page was left starts no other.
let gone = false
function next() {
  clearTimeout(timer)
  if (gone) return
  const soon = (installing.value && !again.value) || agent.value?.waiting || (agent.value && !inventory.value)
  // Not connected: just taken on (checkd reloads, and the agent comes back
  // within seconds), or gone; either way, said soon when that changes.
  const away = agent.value?.connected === false
  timer = setTimeout(async () => {
    await load()
    next()
  }, soon ? 2000 : away ? 5000 : 30000)
}
onMounted(async () => {
  await load()
  next()
})
onUnmounted(() => {
  gone = true
  clearTimeout(timer)
})

/** How far an install has come, and after a minute stuck, why it may be. */
const SLOW = 60_000
const progress = computed(() => {
  const a = agent.value
  if (!a?.waiting) return null
  if (a.fetched) {
    if (a.engine && now.value - a.fetched > SLOW) return { slow: true, text: `${props.host} has the installer, but its agent has not connected. Can it reach ${a.engine}? A firewall here or on ${props.host} may keep it out.` }
    return { slow: false, text: 'Installer fetched; waiting for the agent' }
  }
  if (a.from && a.made && now.value - a.made > SLOW) return { slow: true, text: `${props.host} has not fetched the installer. Can it reach ${a.from}? A firewall here or on ${props.host} may keep it out.` }
  return { slow: false, text: a.from ? `Waiting for ${props.host} to fetch the installer` : 'Waiting for the agent' }
})

const proposals = computed(() => inventory.value?.proposals ?? [])
const chosen = computed(() => proposals.value.filter((p) => ticked.value[p.key]).map((p) => p.key))
const gib = (n: number) => `${Math.round(n / 1024 ** 3)} GiB`
const baseNames = computed(() => {
  const names: Record<string, string> = { memory: 'Memory', load: 'Load', cpu: 'CPU' }
  return (inventory.value?.base ?? []).map((k) => names[k] ?? (k.startsWith('disk:') ? `Disk ${k.slice(5)}` : k))
})

async function decide(add: string[], dismiss: string[]) {
  busy.value = true
  error.value = ''
  try {
    const answer = await api.proposals(props.backend, props.host, add, dismiss)
    added.value = answer.added
    await load()
    live.nudge()
    emit('changed')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    busy.value = false
  }
}

/** Older than the agents nuthatch serves (or too old to say). */
const outdated = computed(() => !!agent.value?.current && agent.value.version !== agent.value.current)

async function update() {
  busy.value = true
  error.value = ''
  try {
    await api.updateAgent(props.backend, props.host)
    await load()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!confirm(`Remove the agent of ${props.host}?`)) return
  try {
    await api.removeAgent(props.backend, props.host)
    await load()
    emit('changed')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
}
</script>

<template>
  <section class="host-agent" :aria-label="`Agent of ${host}`">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="loaded">
      <template v-if="!agent || installing">
        <InstallAgent v-if="installing" :backend="backend" :host="host" :address="address" :os="os" @started="next" />
        <button v-if="again" type="button" class="plain" @click="installAgain(false)">Close</button>
        <button v-else type="button" @click="installing = true">Install agent</button>
      </template>
      <p v-if="progress" :class="progress.slow ? 'warning-text' : 'by'" role="status">{{ progress.text }}</p>

      <template v-if="agent && !agent.waiting">
        <p class="agent-line">
          <span :class="agent.connected === false ? 'warning-text' : ''">Agent{{ agent.connected === false ? ' not connected' : '' }}</span>
          <span v-if="inventory" class="by">
            · {{ inventory.inventory.os.name || inventory.inventory.os.family }} · {{ inventory.inventory.cpus }} CPU · {{ gib(inventory.inventory.memory) }}
          </span>
          <span v-if="agent.version" class="by">&nbsp;· {{ agent.version }}</span>
          <template v-if="outdated">
            <button v-if="agent.updater" type="button" class="quiet" :disabled="busy || agent.updating" @click="update">{{ agent.updating ? 'Updating…' : `Update to ${agent.current}` }}</button>
            <span v-else class="warning-text">Older than {{ agent.current }}</span>
          </template>
          <button v-if="!again" type="button" class="plain" @click="installAgain(true)">Install again</button>
          <button type="button" class="plain" @click="remove">Remove</button>
        </p>
        <p v-if="!inventory" class="by" role="status">Waiting for its inventory</p>
        <p v-if="baseNames.length > 0" class="by">Added: {{ baseNames.join(', ') }}</p>
        <form v-if="proposals.length > 0" class="proposals" aria-label="Proposed checks" @submit.prevent="decide(chosen, [])">
          <fieldset>
            <legend>Proposed</legend>
            <label v-for="p in proposals" :key="p.key" class="suggestion">
              <input v-model="ticked[p.key]" type="checkbox" :name="`proposal-${p.key}`" />
              <span class="what">{{ p.description }}</span>
              <span class="why">{{ p.why }}</span>
            </label>
          </fieldset>
          <div class="buttons">
            <button type="button" class="quiet" :disabled="busy" @click="decide([], proposals.map((p) => p.key))">Dismiss all</button>
            <button type="submit" :disabled="busy || chosen.length === 0">Add {{ chosen.length }} check{{ chosen.length === 1 ? '' : 's' }}</button>
          </div>
        </form>
        <p v-else-if="added.length > 0" class="notice" role="status">Added</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.host-agent {
  display: grid;
  gap: 0.5rem;
}
.agent-line {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.5rem;
  align-items: baseline;
  margin: 0;
}
.proposals fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.proposals legend {
  font-weight: 600;
  margin-bottom: 0.25rem;
}
</style>
