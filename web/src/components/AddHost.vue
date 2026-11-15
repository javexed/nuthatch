<script setup lang="ts">
// Adding a host by looking first: a name, an address or a URL is typed,
// the server looks at what answers there (from where the engine runs),
// and the checks it suggests are ticked or not. On a checkd with agents,
// an agent is installed next, guessed Linux or Windows from what answered.
// The full form is a step away, filled in from what was found, or empty.
import type { ConfigState, Discovery, ManagedHost, TailnetMachine } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onMounted, ref } from 'vue'
import { api } from '../stores/session'

const props = defineProps<{ backend: string; state: ConfigState; busy: boolean; agents?: boolean }>()
const emit = defineEmits<{ check: [host: ManagedHost]; save: [host: ManagedHost, agent?: 'linux' | 'windows']; form: [host?: ManagedHost]; cancel: [] }>()

const target = ref('')
const looking = ref(false)
const error = ref('')
const found = ref<Discovery | null>(null)
const name = ref('')
const template = ref(props.state.templates.host[0] ?? '')
const ticked = ref<boolean[]>([])
/** Its system, guessed; and whether an agent is installed once it is added. */
const system = ref<'linux' | 'windows' | ''>('')
const withAgent = ref(false)

// The tailnet's machines the engine has no host for: one tap to look at one.
const machines = ref<TailnetMachine[]>([])
const allMachines = ref(false)
const FEW = 8
onMounted(async () => {
  try {
    machines.value = (await api.machines(props.backend)).machines
  } catch {
    // Without them, the box above is what there is.
  }
})
const shownMachines = computed(() => (allMachines.value ? machines.value : machines.value.slice(0, FEW)))
/** Short names that two machines share: those are shown by their full names. */
const twice = computed(() => new Set(machines.value.map((m) => m.name).filter((name, n, all) => all.indexOf(name) !== n)))
function lookAt(machine: TailnetMachine) {
  target.value = machine.address
  void look()
}

async function look() {
  if (target.value.trim() === '') return
  looking.value = true
  error.value = ''
  found.value = null
  try {
    const seen = await api.discover(props.backend, target.value)
    found.value = seen
    name.value = props.state.hosts.some((h) => h.name === seen.name) ? '' : seen.name
    ticked.value = seen.suggestions.map((s) => s.checked)
    system.value = seen.system?.family === 'linux' || seen.system?.family === 'windows' ? seen.system.family : ''
    withAgent.value = props.agents === true && system.value !== ''

  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  } finally {
    looking.value = false
  }
}

const count = computed(() => ticked.value.filter(Boolean).length)

function host(): ManagedHost {
  const seen = found.value as Discovery
  const service = props.state.templates.service[0] ?? ''
  return {
    name: name.value.trim(),
    alias: seen.address !== name.value.trim() ? seen.address : undefined,
    address: seen.address,
    use: template.value,
    check_command: seen.host_check,
    hostgroups: [],
    contacts: [],
    contact_groups: [],
    services: seen.suggestions
      .filter((_, n) => ticked.value[n])
      .map((s) => ({ description: s.description, use: service, check_command: s.check_command, servicegroups: [], contacts: [], contact_groups: [] })),
  }
}

function days(n: number): string {
  return n < 0 ? `expired ${-n} days ago` : `expires in ${n} days`
}
</script>

<template>
  <section class="add-host card" aria-label="Add a host">
    <h2>Add a host</h2>
    <form class="look" @submit.prevent="look">
      <label>
        Name, address or URL
        <input
          v-model="target"
          name="target"
          required
          maxlength="300"
          autocapitalize="none"
          autocomplete="off"
          spellcheck="false"
          placeholder="nas.example.com, 192.0.2.20 or https://…"
        />
      </label>
      <button type="submit" :disabled="looking || busy">{{ looking ? 'Scanning…' : 'Scan' }}</button>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="machines.length > 0 && !found && !looking" class="tailnet" role="group" aria-label="On your tailnet, not monitored yet">
      <div class="chips">
        <button
          v-for="machine in shownMachines"
          :key="machine.address"
          type="button"
          :class="['chip', { offline: !machine.online }]"
          :title="`${machine.address}${machine.os ? ` · ${machine.os}` : ''}${machine.online ? '' : ' · offline'}${machine.shared ? ' · shared with you' : ''}`"
          :disabled="busy"
          @click="lookAt(machine)"
        >
          {{ twice.has(machine.name) ? machine.address : machine.name }}<span v-if="!machine.online" class="by"> offline</span>
        </button>
        <button v-if="machines.length > FEW && !allMachines" type="button" class="plain" @click="allMachines = true">and {{ machines.length - FEW }} more</button>
      </div>
    </div>

    <template v-if="found">
      <div class="found">
        <p>
          <strong>{{ found.address }}</strong>
          <span v-if="found.addresses.length > 0 && found.addresses[0] !== found.address" class="by"> · {{ found.addresses.join(', ') }}</span>
        </p>
        <p v-if="found.ping === null" class="by">Ping unavailable</p>
        <p v-else-if="found.ping.ok" class="by">Ping<template v-if="found.ping.ms !== undefined"> {{ found.ping.ms }} ms</template></p>
        <p v-else class="warning-text">
          No ping<template v-if="found.host_check">; checked on port {{ found.host_check.split('!')[1] }}</template>
        </p>
        <p v-if="found.found.length === 0" class="warning-text">No open ports</p>
      </div>

      <div class="fields">
        <label>Name <input v-model.trim="name" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" maxlength="63" autocapitalize="none" /></label>
        <label>
          Template
          <select v-model="template" name="use" required>
            <option v-for="t in state.templates.host" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
      </div>

      <div v-if="agents" class="fields">
        <fieldset class="inline">
          <legend>System<template v-if="found.system"> <span class="by">({{ found.system.why }})</span></template></legend>
          <label><input v-model="system" type="radio" value="linux" name="system" /> Linux</label>
          <label><input v-model="system" type="radio" value="windows" name="system" /> Windows</label>
          <label><input v-model="system" type="radio" value="" name="system" /> Other</label>
        </fieldset>
        <label v-if="system"><input v-model="withAgent" type="checkbox" name="with-agent" /> Install agent</label>
      </div>

      <fieldset v-if="found.suggestions.length > 0" class="suggestions">
        <legend>Checks</legend>
        <label v-for="(s, n) in found.suggestions" :key="s.description" class="suggestion">
          <input v-model="ticked[n]" type="checkbox" :name="`suggestion-${n}`" />
          <span class="what">{{ s.description }}</span>
          <span class="why">{{ s.why }}</span>
        </label>
      </fieldset>
      <details v-if="found.found.some((f) => f.tls)" class="certs">
        <summary>Certificates</summary>
        <ul>
          <li v-for="f in found.found.filter((f) => f.tls)" :key="f.port">
            Port {{ f.port }}: {{ f.tls!.subject ?? 'no name' }}, from {{ f.tls!.issuer ?? 'unknown' }}, {{ days(f.tls!.days) }}{{ f.tls!.trusted ? '' : ', not trusted here' }}
          </li>
        </ul>
      </details>
    </template>

    <div class="buttons">
      <button type="button" class="quiet" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button type="button" class="plain" :disabled="busy" @click="emit('form', found && name ? host() : undefined)">
        {{ found ? 'Full form' : 'Fill in the form myself' }}
      </button>
      <template v-if="found">
        <button type="button" class="quiet" :disabled="busy || !name" @click="emit('check', host())">Check only</button>
        <button type="button" :disabled="busy || !name || !template" @click="emit('save', host(), withAgent && system ? system : undefined)">
          Add {{ name || 'host' }}{{ count > 0 ? ` with ${count} check${count === 1 ? '' : 's'}` : '' }}
        </button>
      </template>
    </div>
  </section>
</template>
