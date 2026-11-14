<script setup lang="ts">
// A contact, to add or to change.
import type { ConfigState, ManagedContact } from '@nuthatch/api'
import { reactive } from 'vue'

const props = defineProps<{ state: ConfigState; contact?: ManagedContact; busy: boolean }>()
const emit = defineEmits<{ check: [contact: ManagedContact]; save: [contact: ManagedContact]; cancel: [] }>()

const periods = props.state.choices.timeperiods ?? []
const HOST = ['d', 'u', 'r', 'f', 's'] as const
const SERVICE = ['w', 'u', 'c', 'r', 'f', 's'] as const
const NAMES: Record<string, string> = { d: 'down', u: 'unreachable / unknown', r: 'recovery', f: 'flapping', s: 'downtime', w: 'warning', c: 'critical' }
const c = props.contact
const form = reactive({
  name: c?.name ?? '',
  alias: c?.alias ?? '',
  email: c?.email ?? '',
  pager: c?.pager ?? '',
  hostPeriod: c?.host_notification_period ?? periods[0] ?? '',
  servicePeriod: c?.service_notification_period ?? periods[0] ?? '',
  hostOptions: (c?.host_notification_options ?? 'd,u,r').split(','),
  serviceOptions: (c?.service_notification_options ?? 'w,u,c,r').split(','),
  hostCommands: [...(c?.host_notification_commands ?? [])],
  serviceCommands: [...(c?.service_notification_commands ?? [])],
  digest: c?.digest?.command ?? '',
  wait: c?.digest?.wait ?? ('' as number | ''),
})

function result(): ManagedContact {
  return {
    name: form.name.trim(),
    alias: form.alias.trim() || undefined,
    email: form.email.trim() || undefined,
    pager: form.pager.trim() || undefined,
    host_notification_period: form.hostPeriod,
    service_notification_period: form.servicePeriod,
    host_notification_options: form.hostOptions.join(',') || 'n',
    service_notification_options: form.serviceOptions.join(',') || 'n',
    host_notification_commands: form.hostCommands,
    service_notification_commands: form.serviceCommands,
    ...(form.digest ? { digest: { command: form.digest, ...(form.wait === '' ? {} : { wait: Number(form.wait) }) } } : {}),
  }
}
</script>

<template>
  <form class="contact-form card" @submit.prevent="emit('save', result())">
    <h2>{{ contact ? `Change ${contact.name}` : 'New contact' }}</h2>
    <div class="fields">
      <label>Name <input v-model.trim="form.name" name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" maxlength="63" autocapitalize="none" /></label>
      <label>Alias <input v-model="form.alias" name="alias" maxlength="200" /></label>
      <label>E-mail <input v-model.trim="form.email" name="email" type="email" maxlength="200" autocapitalize="none" /></label>
      <label>Pager <input v-model.trim="form.pager" name="pager" maxlength="200" /></label>
      <label>
        Host period
        <select v-model="form.hostPeriod" name="host-period" required>
          <option v-for="p in periods" :key="p" :value="p">{{ p }}</option>
        </select>
      </label>
      <label>
        Service period
        <select v-model="form.servicePeriod" name="service-period" required>
          <option v-for="p in periods" :key="p" :value="p">{{ p }}</option>
        </select>
      </label>
      <fieldset class="wide">
        <legend>Hosts</legend>
        <label v-for="l in HOST" :key="l" class="check"><input v-model="form.hostOptions" type="checkbox" :value="l" /> {{ NAMES[l] }}</label>
      </fieldset>
      <fieldset class="wide">
        <legend>Services</legend>
        <label v-for="l in SERVICE" :key="l" class="check"><input v-model="form.serviceOptions" type="checkbox" :value="l" /> {{ NAMES[l] }}</label>
      </fieldset>
      <label>
        Host commands
        <select v-model="form.hostCommands" name="host-commands" multiple required>
          <option v-for="n in state.choices.commands" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <label>
        Service commands
        <select v-model="form.serviceCommands" name="service-commands" multiple required>
          <option v-for="n in state.choices.commands" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <template v-if="state.extras">
        <label>
          Digest
          <select v-model="form.digest" name="digest">
            <option value="">off</option>
            <option v-for="n in state.choices.commands" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label v-if="form.digest">Digest wait (s) <input v-model.number="form.wait" name="digest-wait" type="number" min="1" max="3600" placeholder="30" /></label>
      </template>
    </div>
    <div class="buttons">
      <button type="button" class="quiet" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button type="button" class="quiet" :disabled="busy" @click="emit('check', result())">Check only</button>
      <button type="submit" :disabled="busy">Save and apply</button>
    </div>
  </form>
</template>
