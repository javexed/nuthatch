<script setup lang="ts">
import { type Changes, compare, portsOf, withGained } from '../lib/rediscover'
// The hosts and services nuthatch keeps the config of: adding, changing
// and taking away. Every change is checked by the engine itself before it
// is written, and the engine then reads its config again.
import type { ConfigChange, ConfigResult, ConfigState, ManagedHost } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import AddHost from '../components/AddHost.vue'
import HostForm from '../components/HostForm.vue'
import { useLive } from '../stores/live'
import { api, useSession } from '../stores/session'

const session = useSession()
const live = useLive()
const backends = computed(() => session.session?.config_backends ?? [])
const backend = ref(backends.value[0] ?? '')
const state = ref<ConfigState | null>(null)
const error = ref('')
/** The host in the form: one being changed, 'new', or none. */
const editing = ref<ManagedHost | 'new' | null>(null)
/** A new host: looked at first, or in the full form (with what was found, if anything). */
const adding = ref<{ step: 'look' } | { step: 'form'; start?: ManagedHost }>({ step: 'look' })
const busy = ref(false)
const notice = ref('')
/** What the engine's own check said, when it refused, or on a check only. */
const report = ref<{ title: string; output: string; text?: string } | null>(null)

async function load() {
  if (backend.value === '') return
  try {
    state.value = await api.config(backend.value)
    error.value = ''
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'The server cannot be reached.'
  }
}
watch(backend, () => {
  state.value = null
  editing.value = null
  void load()
}, { immediate: true })

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
    const message = err instanceof ApiError ? err.message : 'The server cannot be reached.'
    const output = err instanceof ApiError && typeof err.detail.output === 'string' ? err.detail.output : ''
    report.value = { title: `Not changed: ${message}.`, output }
    if (err instanceof ApiError && err.status === 409) await load()
    return false
  } finally {
    busy.value = false
  }
}

async function save(host: ManagedHost) {
  const previous = editing.value !== 'new' && editing.value !== null ? editing.value.name : undefined
  if (await send({ kind: 'put', host, previous }, false, `${host.name} is saved, and the engine has it.`)) editing.value = null
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
    again.value[host.name] = { looking: false, error: err instanceof ApiError ? err.message : 'The server cannot be reached.' }
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
  <p v-if="backends.length === 0" class="none">
    No backend's config can be changed here, or you have not the role for it (config_edit).
  </p>
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
      <AddHost
        v-if="editing === 'new' && adding.step === 'look'"
        :backend="backend"
        :state="state"
        :busy="busy"
        @check="check"
        @save="save"
        @form="(start) => (adding = { step: 'form', start })"
        @cancel="editing = null"
      />
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
        <p class="notice">
          These are the hosts nuthatch keeps the config of on {{ backend }}. The engine's other hosts are in its own files.
        </p>
        <ul v-if="state.hosts.length > 0" class="managed">
          <li v-for="host in state.hosts" :key="host.name" class="card">
            <div>
              <strong>{{ host.name }}</strong> <span class="by">{{ host.address }} · {{ host.use }}</span>
              <p v-if="host.services.length > 0" class="by">Services: {{ host.services.map((s) => s.description).join(', ') }}</p>
              <div v-if="again[host.name] && !again[host.name]!.looking" class="again" aria-live="polite">
                <p v-if="again[host.name]!.error" class="error">{{ again[host.name]!.error }}</p>
                <template v-else-if="again[host.name]!.changes">
                  <p v-if="again[host.name]!.changes!.gained.length === 0 && again[host.name]!.changes!.lost.length === 0">
                    Nothing has changed: what answers there is what is checked.
                  </p>
                  <template v-if="again[host.name]!.changes!.gained.length > 0">
                    <p><strong>Answers now, and is not checked:</strong></p>
                    <ul>
                      <li v-for="s in again[host.name]!.changes!.gained" :key="s.check_command">{{ s.description }} <span class="by">{{ s.why }}</span></li>
                    </ul>
                    <button type="button" :disabled="busy" @click="addGained(host)">
                      Add {{ again[host.name]!.changes!.gained.length === 1 ? 'this check' : `these ${again[host.name]!.changes!.gained.length} checks` }}…
                    </button>
                  </template>
                  <template v-if="again[host.name]!.changes!.lost.length > 0">
                    <p><strong>Checked, and nothing answers there now:</strong></p>
                    <ul>
                      <li v-for="l in again[host.name]!.changes!.lost" :key="l.description">{{ l.description }} <span class="by">port {{ l.port }}</span></li>
                    </ul>
                  </template>
                </template>
              </div>
            </div>
            <div class="actions">
              <button type="button" class="quiet" :disabled="busy || again[host.name]?.looking" @click="lookAgain(host)">
                {{ again[host.name]?.looking ? 'Looking…' : 'Look again' }}
              </button>
              <button type="button" class="quiet" :disabled="busy" @click="editing = host">Change</button>
              <button type="button" class="plain" :disabled="busy" @click="remove(host)">Take out</button>
            </div>
          </li>
        </ul>
        <p v-else class="none">None yet.</p>
        <ul v-if="state.unreadable.length > 0" class="unreadable">
          <li v-for="file in state.unreadable" :key="file.file">
            <strong>{{ file.file }}</strong> was changed by hand and is left alone: {{ file.why }}.
          </li>
        </ul>
      </template>
    </template>
  </template>
</template>
