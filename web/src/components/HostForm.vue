<script setup lang="ts">
// A host and its services, to add or to change.
import type { ConfigState, ManagedHost, ManagedService } from '@nuthatch/api'
import { reactive } from 'vue'

const props = defineProps<{
  state: ConfigState
  /** The host being changed; none for a new one. */
  host?: ManagedHost
  /** What a new host's form starts with, such as what looking at it found. */
  start?: ManagedHost
  busy: boolean
}>()
const emit = defineEmits<{ check: [host: ManagedHost]; save: [host: ManagedHost]; cancel: [] }>()

interface Command {
  name: string
  args: string
}
const split = (line: string | undefined): Command => {
  const at = (line ?? '').indexOf('!')
  return at < 0 ? { name: line ?? '', args: '' } : { name: (line ?? '').slice(0, at), args: (line ?? '').slice(at + 1) }
}
const joined = (c: Command) => (c.name === '' ? undefined : c.args === '' ? c.name : `${c.name}!${c.args}`)

/** What a service is: checked by a command, told its result, or worked out from others. */
type Kind = 'command' | 'push' | 'aggregate'
interface Extra {
  kind: Kind
  /** Hours within which a push is expected; empty for no alarm. */
  hours: number | ''
  token: string
  /** Members, one to a line. */
  members: string
  min: string
}
const extraOf = (s?: ManagedService): Extra => ({
  kind: s?.push ? 'push' : s?.aggregate ? 'aggregate' : 'command',
  hours: s?.push?.every ? Math.round((s.push.every / 3600) * 100) / 100 : '',
  token: s?.push?.token ?? '',
  members: (s?.aggregate?.members ?? []).join('\n'),
  min: s?.aggregate?.min ?? '',
})

const blank = (): ManagedService => ({ description: '', use: props.state.templates.service[0] ?? '', servicegroups: [], contacts: [], contact_groups: [] })
const form = reactive({
  ...(JSON.parse(JSON.stringify(props.host ?? props.start ?? { name: '', address: '', use: props.state.templates.host[0] ?? '', hostgroups: [], contacts: [], contact_groups: [], services: [] })) as ManagedHost),
  command: split((props.host ?? props.start)?.check_command),
  serviceCommands: ((props.host ?? props.start)?.services ?? []).map((s) => split(s.check_command)),
  extras: ((props.host ?? props.start)?.services ?? []).map((s) => extraOf(s)),
})

function addService() {
  form.services.push(blank())
  form.serviceCommands.push({ name: '', args: '' })
  form.extras.push(extraOf())
}

function removeService(n: number) {
  form.services.splice(n, 1)
  form.serviceCommands.splice(n, 1)
  form.extras.splice(n, 1)
}

function result(): ManagedHost {
  const { command, serviceCommands, extras, ...host } = JSON.parse(JSON.stringify(form)) as ManagedHost & { command: Command; serviceCommands: Command[]; extras: Extra[] }
  return {
    ...host,
    check_command: joined(command),
    services: host.services.map((service, n) => {
      const extra = extras[n] ?? extraOf()
      const { push: _push, aggregate: _aggregate, ...plain } = service
      if (extra.kind === 'push') {
        // An empty token asks the server for a new one.
        return { ...plain, check_command: undefined, push: { token: extra.token, ...(extra.hours === '' ? {} : { every: Math.round(Number(extra.hours) * 3600) }) } }
      }
      if (extra.kind === 'aggregate') {
        const members = extra.members.split('\n').map((m) => m.trim()).filter((m) => m !== '')
        return { ...plain, check_command: undefined, aggregate: { members, ...(extra.min.trim() === '' ? {} : { min: extra.min.trim() }) } }
      }
      return { ...plain, check_command: joined(serviceCommands[n] ?? { name: '', args: '' }) }
    }),
  }
}
</script>

<template>
  <form class="host-form card" @submit.prevent="emit('save', result())">
    <h2>{{ host ? `Change ${host.name}` : 'Add a host' }}</h2>
    <div class="fields">
      <label>Name <input v-model.trim="form.name" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" maxlength="63" autocapitalize="none" /></label>
      <label>Address <input v-model.trim="form.address" name="address" required maxlength="255" autocapitalize="none" placeholder="a name or an IP address" /></label>
      <label>Alias <input v-model="form.alias" name="alias" maxlength="200" /></label>
      <label>
        Template
        <select v-model="form.use" name="use" required>
          <option v-for="name in state.templates.host" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>
        Check command
        <select v-model="form.command.name" name="command">
          <option value="">the template's</option>
          <option v-for="name in state.choices.commands" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label v-if="form.command.name">Its arguments, separated by ! <input v-model="form.command.args" name="args" maxlength="400" /></label>
      <label>
        Host groups
        <select v-model="form.hostgroups" name="hostgroups" multiple>
          <option v-for="name in state.choices.hostgroups" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>
        Contact groups
        <select v-model="form.contact_groups" name="contact_groups" multiple>
          <option v-for="name in state.choices.contactgroups" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>
        Contacts
        <select v-model="form.contacts" name="contacts" multiple>
          <option v-for="name in state.choices.contacts" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>Notes <input v-model="form.notes" name="notes" maxlength="400" /></label>
    </div>

    <h3>Services</h3>
    <fieldset v-for="(service, n) in form.services" :key="n" class="service-fields">
      <legend>Service {{ n + 1 }}</legend>
      <div class="fields">
        <label>Name <input v-model.trim="service.description" :name="`service-${n}-name`" required maxlength="63" /></label>
        <label>
          Template
          <select v-model="service.use" :name="`service-${n}-use`" required>
            <option v-for="name in state.templates.service" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label v-if="state.extras">
          How its state is found
          <select v-model="form.extras[n]!.kind" :name="`service-${n}-kind`">
            <option value="command">by running a command</option>
            <option value="push">a job elsewhere tells it</option>
            <option value="aggregate">from other hosts and services</option>
          </select>
        </label>
        <template v-if="form.extras[n]!.kind === 'command'">
          <label>
            Check command
            <select v-model="form.serviceCommands[n]!.name" :name="`service-${n}-command`">
              <option value="">the template's</option>
              <option v-for="name in state.choices.commands" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label v-if="form.serviceCommands[n]!.name">
            Its arguments, separated by !
            <input v-model="form.serviceCommands[n]!.args" :name="`service-${n}-args`" maxlength="400" />
          </label>
        </template>
        <template v-else-if="form.extras[n]!.kind === 'push'">
          <label>
            Alarm when nothing came for this many hours
            <input v-model="form.extras[n]!.hours" :name="`service-${n}-hours`" type="number" min="0.02" max="8784" step="any" placeholder="no alarm" />
          </label>
          <p class="by wide">
            {{ form.extras[n]!.token ? 'It keeps the address it has.' : 'Its address is made when it is saved.' }}
            The address to call is on the service's own page.
          </p>
        </template>
        <template v-else>
          <label class="wide">
            Members, one to a line
            <textarea
              v-model="form.extras[n]!.members"
              :name="`service-${n}-members`"
              rows="4"
              required
              autocapitalize="none"
              spellcheck="false"
              placeholder="web1&#10;web*/http&#10;@webs/disk"
            ></textarea>
          </label>
          <label>
            How many must be OK
            <input v-model.trim="form.extras[n]!.min" :name="`service-${n}-min`" pattern="\d{1,4}%?" maxlength="5" placeholder="all" />
          </label>
          <p class="by wide">A host (web1, web*, @group for a host group), or host/service. As bad as the worst member; with a number or a percentage, OK while that many are.</p>
        </template>
        <label>
          Service groups
          <select v-model="service.servicegroups" :name="`service-${n}-groups`" multiple>
            <option v-for="name in state.choices.servicegroups" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <label>
          Contact groups
          <select v-model="service.contact_groups" :name="`service-${n}-contact-groups`" multiple>
            <option v-for="name in state.choices.contactgroups" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
      </div>
      <button type="button" class="plain" @click="removeService(n)">Remove this service</button>
    </fieldset>
    <button type="button" class="quiet" @click="addService">Add a service</button>

    <div class="buttons">
      <button type="button" class="quiet" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button type="button" class="quiet" :disabled="busy" @click="emit('check', result())">Check only</button>
      <button type="submit" :disabled="busy">Save and apply</button>
    </div>
  </form>
</template>
