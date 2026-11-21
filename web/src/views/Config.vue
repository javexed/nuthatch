<script setup lang="ts">
import { type Changes, compare, portsOf, withGained } from '../lib/rediscover'
// The hosts and services nuthatch keeps the config of: adding, changing
// and taking away. Every change is checked by the engine itself before it
// is written, and the engine then reads its config again.
import type { AgentRow, ConfigChange, ConfigResult, ConfigState, DeliverySettings, ManagedContact, ManagedGroup, ManagedHost } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AddHost from '../components/AddHost.vue'
import AssistantSettings from '../components/AssistantSettings.vue'
import ContactForm from '../components/ContactForm.vue'
import DeliveryForm from '../components/DeliveryForm.vue'
import GroupForm from '../components/GroupForm.vue'
import HostAgent from '../components/HostAgent.vue'
import HostForm from '../components/HostForm.vue'
import { useLive } from '../stores/live'
import { api, useSession } from '../stores/session'

const session = useSession()
const live = useLive()
const route = useRoute()
const router = useRouter()
const backends = computed(() => session.session?.config_backends ?? [])
const backend = ref(backends.value[0] ?? '')
const state = ref<ConfigState | null>(null)
const error = ref('')
/** The host in the form: one being changed, 'new', or none. */
const editing = ref<ManagedHost | 'new' | null>(null)
/** The group in its form: one being changed, a new one of a kind, or none. */
const group = ref<ManagedGroup | { new: ManagedGroup['type'] } | null>(null)
/** The contact in its form: one being changed, a new one, or none. */
const contact = ref<ManagedContact | 'new' | null>(null)
/** Choosing the host a new service goes on. */
const choosingHost = ref(false)
/** A new host: looked at first, or in the full form (with what was found, if anything). */
const adding = ref<{ step: 'look' } | { step: 'form'; start?: ManagedHost }>({ step: 'look' })
const busy = ref(false)
const notice = ref('')
/** What the engine's own check said, when it refused, or on a check only. */
const report = ref<{ title: string; output: string; text?: string } | null>(null)

/** checkd's agents on this backend, by host, when it has any. */
const hasAgents = computed(() => (session.session?.agent_backends ?? []).includes(backend.value))
const agents = ref<AgentRow[]>([])
const agentOf = computed(() => new Map(agents.value.map((a) => [a.host, a])))
/** A host just added, its agent being installed. */
const settingUp = ref<{ name: string; address: string; os: 'linux' | 'windows' } | null>(null)
/** Hosts whose agent panel is open. */
const agentOpen = ref<Record<string, boolean>>({})

async function loadAgents() {
  if (!hasAgents.value) {
    agents.value = []
    return
  }
  try {
    agents.value = (await api.agents(backend.value)).agents
  } catch {
    agents.value = []
  }
}

/** How nuthatch sends mail, chat and ntfy; null where notifications are not set up. */
const delivery = ref<(DeliverySettings & { topic: string }) | null>(null)
const sending = ref(false)
async function loadDelivery() {
  try {
    delivery.value = await api.delivery()
  } catch {
    delivery.value = null
  }
}
function savedDelivery(saved: DeliverySettings) {
  delivery.value = { ...saved, topic: delivery.value?.topic ?? '' }
}
const ways = (k: ManagedContact) =>
  [k.reach?.email ? 'e-mail' : '', k.reach?.chat ? `chat ${k.reach.chat}` : '', k.reach?.ntfy ? 'ntfy' : ''].filter(Boolean)

async function load() {
  if (backend.value === '') return
  if (delivery.value === null) void loadDelivery()
  try {
    state.value = await api.config(backend.value)
    error.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
  await loadAgents()
}
watch(backend, () => {
  state.value = null
  editing.value = null
  group.value = null
  void load()
}, { immediate: true })

// Come from a page's "New" button: ?new=host|service|hostgroup|servicegroup.
watch(
  [() => route.query.new, state],
  ([wanted]) => {
    if (!state.value || typeof wanted !== 'string') return
    if (wanted === 'host') startAdding()
    else if (wanted === 'service') choosingHost.value = true
    else if (wanted === 'hostgroup' || wanted === 'servicegroup') group.value = { new: wanted }
    void router.replace({ query: { ...route.query, new: undefined } })
  },
  { immediate: true },
)

/** Opens a host's form with a new service at the end. */
function addServiceTo(host: ManagedHost) {
  choosingHost.value = false
  editing.value = {
    ...host,
    services: [...host.services, { description: '', use: state.value?.templates.service[0] ?? '', servicegroups: [], contacts: [], contact_groups: [] }],
  }
}

async function saveGroup(g: ManagedGroup) {
  const previous = group.value !== null && 'name' in group.value ? group.value.name : undefined
  if (await send({ kind: 'put-group', group: g, previous }, false, `${g.name} is saved, and the engine has it.`)) group.value = null
}

function checkGroupOnly(g: ManagedGroup) {
  const previous = group.value !== null && 'name' in group.value ? group.value.name : undefined
  return send({ kind: 'put-group', group: g, previous }, true, '')
}

async function saveContact(k: ManagedContact) {
  const previous = contact.value !== null && contact.value !== 'new' ? contact.value.name : undefined
  if (await send({ kind: 'put-contact', contact: k, previous }, false, `${k.name} is saved, and the engine has it.`)) contact.value = null
}

function checkContactOnly(k: ManagedContact) {
  const previous = contact.value !== null && contact.value !== 'new' ? contact.value.name : undefined
  return send({ kind: 'put-contact', contact: k, previous }, true, '')
}

async function removeContact(k: ManagedContact) {
  if (!window.confirm(`Take the contact ${k.name} out of the config?`)) return
  await send({ kind: 'delete-contact', name: k.name }, false, `${k.name} is taken out.`)
}

async function removeGroup(g: ManagedGroup) {
  if (!window.confirm(`Take the ${g.type} ${g.name} out of the config? Its members stay.`)) return
  await send({ kind: 'delete-group', type: g.type, name: g.name }, false, `${g.name} is taken out.`)
}

async function send(change: ConfigChange, dryRun: boolean, done: string): Promise<boolean> {
  if (!state.value) return false
  busy.value = true
  notice.value = dryRun ? 'The engine is checking…' : 'The engine is checking, and then reading its config again…'
  report.value = null
  try {
    const result: ConfigResult = await api.changeConfig(backend.value, state.value.revision, change, dryRun)
    notice.value = done
    if (dryRun) report.value = { title: 'The engine takes this config. It would be written as:', output: result.output, text: result.text }
    else {
      await load()
      live.nudge()
    }
    return true
  } catch (err) {
    notice.value = ''
    const message = err instanceof ApiError ? err.message : 'Server unreachable'
    const output = err instanceof ApiError && typeof err.detail.output === 'string' ? err.detail.output : ''
    report.value = { title: `Not changed: ${message}.`, output }
    if (err instanceof ApiError && err.status === 409) await load()
    return false
  } finally {
    busy.value = false
  }
}

async function save(host: ManagedHost, agent?: 'linux' | 'windows') {
  const previous = editing.value !== 'new' && editing.value !== null ? editing.value.name : undefined
  if (!(await send({ kind: 'put', host, previous }, false, `${host.name} is saved, and the engine has it.`))) return
  editing.value = null
  if (agent) {
    settingUp.value = { name: host.name, address: host.address, os: agent }
  }
}

const check = (host: ManagedHost) => {
  const previous = editing.value !== 'new' && editing.value !== null ? editing.value.name : undefined
  return send({ kind: 'put', host, previous }, true, '')
}

/** A host looked at again: what it has gained and lost, by its name. */
const again = ref<Record<string, { looking: boolean; changes?: Changes; error?: string }>>({})

async function lookAgain(host: ManagedHost) {
  again.value[host.name] = { looking: true }
  try {
    again.value[host.name] = { looking: false, changes: compare(host, await api.discover(backend.value, host.address, portsOf(host))) }
  } catch (err) {
    again.value[host.name] = { looking: false, error: err instanceof ApiError ? err.message : 'Server unreachable' }
  }
}

/** Opens the form with the gained checks added, to look over and save. */
function addGained(host: ManagedHost) {
  const gained = again.value[host.name]?.changes?.gained ?? []
  editing.value = withGained(host, gained, state.value?.templates.service[0] ?? '')
  // Saved under the name it has.
  delete again.value[host.name]
}

function startAdding() {
  adding.value = { step: 'look' }
  report.value = null
  editing.value = 'new'
}

async function remove(host: ManagedHost) {
  if (!window.confirm(`Take ${host.name} and its ${host.services.length} services out of the config? Their history stays in the log.`)) return
  await send({ kind: 'delete', name: host.name }, false, `${host.name} is taken out.`)
}
</script>

<template>
  <h1>Config</h1>
  <p v-if="backends.length === 0" class="none">Not available</p>
  <template v-else>
    <label v-if="backends.length > 1" class="backend-choice">
      Backend
      <select v-model="backend" name="backend" :disabled="busy || editing !== null">
        <option v-for="name in backends" :key="name" :value="name">{{ name }}</option>
      </select>
    </label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <section v-if="report" class="card report" role="alert">
      <p><strong>{{ report.title }}</strong></p>
      <pre v-if="report.text" class="long">{{ report.text }}</pre>
      <details v-if="report.output" :open="!report.text">
        <summary>What the engine's check said</summary>
        <pre class="long">{{ report.output }}</pre>
      </details>
    </section>

    <template v-if="state">
      <section v-if="settingUp" class="card" :aria-label="`Setting up ${settingUp.name}`">
        <h2>{{ settingUp.name }}</h2>
        <HostAgent :backend="backend" :host="settingUp.name" :address="settingUp.address" :os="settingUp.os" install @changed="load" />
        <div class="buttons"><button type="button" class="quiet" @click="settingUp = null">Close</button></div>
      </section>
      <AddHost
        v-else-if="editing === 'new' && adding.step === 'look'"
        :backend="backend"
        :state="state"
        :busy="busy"
        :agents="hasAgents"
        @check="check"
        @save="save"
        @form="(start) => (adding = { step: 'form', start })"
        @cancel="editing = null"
      />
      <GroupForm
        v-else-if="group !== null"
        :key="'new' in group ? ` new ${group.new}` : `${group.type} ${group.name}`"
        :state="state"
        :group="'new' in group ? undefined : group"
        :type="'new' in group ? group.new : group.type"
        :busy="busy"
        @check="checkGroupOnly"
        @save="saveGroup"
        @cancel="group = null"
      />
      <template v-else-if="contact !== null">
      <ContactForm
        :key="contact === 'new' ? ' new' : contact.name"
        :state="state"
        :contact="contact === 'new' ? undefined : contact"
        :busy="busy"
        :delivery="delivery"
        @check="checkContactOnly"
        @save="saveContact"
        @cancel="contact = null"
        @sending="sending = true"
      />
      <DeliveryForm v-if="sending && delivery" :settings="delivery" @saved="savedDelivery" @close="sending = false" />
      </template>
      <section v-else-if="choosingHost" class="card choose-host" aria-label="Which host">
        <h2>New service on</h2>
        <p v-if="state.hosts.length === 0" class="none">No hosts yet</p>
        <div v-else class="chips">
          <button v-for="h in state.hosts" :key="h.name" type="button" class="chip" @click="addServiceTo(h)">{{ h.name }}</button>
        </div>
        <div class="buttons"><button type="button" class="quiet" @click="choosingHost = false">Cancel</button></div>
      </section>
      <HostForm
        v-else-if="editing !== null"
        :key="editing === 'new' ? ' new' : editing.name"
        :state="state"
        :host="editing === 'new' ? undefined : editing"
        :start="editing === 'new' && adding.step === 'form' ? adding.start : undefined"
        :busy="busy"
        @check="check"
        @save="save"
        @cancel="editing = null"
      />
      <template v-else>
        <p>
          <button type="button" :disabled="busy || state.templates.host.length === 0" @click="startAdding">Add a host</button>
        </p>
        <p v-if="state.templates.host.length === 0" class="error">
          The engine's config has no host template (a host with a name and register 0) to build a host on.
        </p>
        <h2>Hosts</h2>
        <ul v-if="state.hosts.length > 0" class="managed">
          <li v-for="host in state.hosts" :key="host.name" class="card">
            <div>
              <strong>{{ host.name }}</strong> <span class="by">{{ host.address }} · {{ host.use }}</span>
              <span v-if="agentOf.get(host.name)?.proposals" class="badge">{{ agentOf.get(host.name)!.proposals }} proposed</span>
              <p v-if="host.services.length > 0" class="by">{{ host.services.map((s) => s.description).join(', ') }}</p>
              <div v-if="again[host.name] && !again[host.name]!.looking" class="again" aria-live="polite">
                <p v-if="again[host.name]!.error" class="error">{{ again[host.name]!.error }}</p>
                <template v-else-if="again[host.name]!.changes">
                  <p v-if="again[host.name]!.changes!.gained.length === 0 && again[host.name]!.changes!.lost.length === 0">No change</p>
                  <template v-if="again[host.name]!.changes!.gained.length > 0">
                    <p><strong>New</strong></p>
                    <ul>
                      <li v-for="s in again[host.name]!.changes!.gained" :key="s.check_command">{{ s.description }} <span class="by">{{ s.why }}</span></li>
                    </ul>
                    <button type="button" :disabled="busy" @click="addGained(host)">
                      Add {{ again[host.name]!.changes!.gained.length === 1 ? 'this check' : `these ${again[host.name]!.changes!.gained.length} checks` }}…
                    </button>
                  </template>
                  <template v-if="again[host.name]!.changes!.lost.length > 0">
                    <p><strong>Gone</strong></p>
                    <ul>
                      <li v-for="l in again[host.name]!.changes!.lost" :key="l.description">{{ l.description }} <span class="by">port {{ l.port }}</span></li>
                    </ul>
                  </template>
                </template>
              </div>
              <HostAgent v-if="agentOpen[host.name]" :backend="backend" :host="host.name" :address="host.address" :install="!agentOf.get(host.name)" @changed="load" />
            </div>
            <div class="actions">
              <button v-if="hasAgents" type="button" class="quiet" :aria-pressed="agentOpen[host.name] === true" @click="agentOpen[host.name] = !agentOpen[host.name]">
                {{ agentOf.get(host.name) || agentOpen[host.name] ? 'Agent' : 'Install agent' }}
              </button>
              <button type="button" class="quiet" :disabled="busy || again[host.name]?.looking" @click="lookAgain(host)">
                {{ again[host.name]?.looking ? 'Scanning…' : 'Scan again' }}
              </button>
              <button type="button" class="quiet" :disabled="busy" @click="editing = host">Change</button>
              <button type="button" class="plain" :disabled="busy" @click="remove(host)">Take out</button>
            </div>
          </li>
        </ul>
        <p v-else class="none">None</p>
        <template v-if="agents.some((a) => !state!.hosts.some((h) => h.name === a.host))">
          <h2 class="groups-head">Other agents</h2>
          <ul class="managed">
            <li v-for="a in agents.filter((a) => !state!.hosts.some((h) => h.name === a.host))" :key="a.host" class="card">
              <div>
                <RouterLink :to="{ name: 'host', params: { backend, host: a.host } }"><strong>{{ a.host }}</strong></RouterLink>
                <span class="by"> {{ a.os ?? '' }}{{ a.waiting ? ' · waiting' : a.connected === false ? ' · not connected' : '' }}</span>
              </div>
            </li>
          </ul>
        </template>
        <h2 class="groups-head">Groups</h2>
        <p>
          <button type="button" class="quiet" :disabled="busy" @click="group = { new: 'hostgroup' }">Add a host group</button>
          <button type="button" class="quiet" :disabled="busy" @click="group = { new: 'servicegroup' }">Add a service group</button>
        </p>
        <ul v-if="(state.groups ?? []).length > 0" class="managed">
          <li v-for="g in state.groups" :key="`${g.type} ${g.name}`" class="card">
            <div>
              <strong>{{ g.name }}</strong> <span class="by">{{ g.type === 'hostgroup' ? 'host group' : 'service group' }}{{ g.alias ? ` · ${g.alias}` : '' }}</span>
              <p v-if="g.members.length > 0" class="by">{{ g.members.join(', ') }}</p>
            </div>
            <div class="actions">
              <button type="button" class="quiet" :disabled="busy" @click="group = g">Change</button>
              <button type="button" class="plain" :disabled="busy" @click="removeGroup(g)">Take out</button>
            </div>
          </li>
        </ul>
        <h2 class="groups-head">Contacts</h2>
        <p>
          <button type="button" class="quiet" :disabled="busy" @click="contact = 'new'">Add a contact</button>
          <button v-if="delivery" type="button" class="quiet" :aria-pressed="sending" @click="sending = !sending">Notification channels</button>
        </p>
        <DeliveryForm v-if="sending && delivery && contact === null" :settings="delivery" @saved="savedDelivery" @close="sending = false" />
        <ul v-if="(state.contacts ?? []).length > 0" class="managed">
          <li v-for="k in state.contacts" :key="k.name" class="card">
            <div>
              <strong>{{ k.name }}</strong> <span class="by">{{ [k.email ?? '', ...ways(k), k.digest ? 'digest' : ''].filter(Boolean).join(' · ') }}</span>
            </div>
            <div class="actions">
              <button type="button" class="quiet" :disabled="busy" @click="contact = k">Change</button>
              <button type="button" class="plain" :disabled="busy" @click="removeContact(k)">Take out</button>
            </div>
          </li>
        </ul>
        <template v-if="session.session?.assistant?.set_key">
          <h2 class="groups-head">Assistant</h2>
          <AssistantSettings />
        </template>
        <ul v-if="state.unreadable.length > 0" class="unreadable">
          <li v-for="file in state.unreadable" :key="file.file">
            <strong>{{ file.file }}</strong> was changed by hand and is left alone: {{ file.why }}.
          </li>
        </ul>
      </template>
    </template>
  </template>
</template>
