<script setup lang="ts">
// A contact, to add or to change.
import type { ConfigState, DeliverySettings, ManagedContact } from '@nuthatch/api'
import { computed, reactive, ref } from 'vue'
import { api } from '../stores/session'
import QrCode from './QrCode.vue'

const props = defineProps<{ state: ConfigState; contact?: ManagedContact; busy: boolean; delivery?: (DeliverySettings & { topic: string }) | null }>()
const emit = defineEmits<{ check: [contact: ManagedContact]; save: [contact: ManagedContact]; cancel: []; sending: [] }>()

/** nuthatch's own no-op command: written for a contact it reaches, never chosen. */
const NOTIFY = 'nuthatch_notify'
const commands = computed(() => props.state.choices.commands.filter((n) => n !== NOTIFY))
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
  hostCommands: (c?.host_notification_commands ?? []).filter((n) => n !== NOTIFY),
  serviceCommands: (c?.service_notification_commands ?? []).filter((n) => n !== NOTIFY),
  byEmail: c?.reach?.email === true,
  chat: c?.reach?.chat ?? '',
  byNtfy: !!c?.reach?.ntfy,
  topic: c?.reach?.ntfy ?? props.delivery?.topic ?? '',
  digest: c?.digest?.command ?? '',
  wait: c?.digest?.wait ?? ('' as number | ''),
})

const reached = computed(() => (form.byEmail && !!form.email) || !!form.chat || (form.byNtfy && !!form.topic))
const ntfyLink = computed(() => `${props.delivery?.ntfy.server ?? 'https://ntfy.sh'}/${form.topic}`)
const tested = ref('')
async function testNtfy() {
  tested.value = ''
  try {
    await api.testDelivery({ kind: 'ntfy', topic: form.topic })
    tested.value = 'Sent'
  } catch (err) {
    tested.value = err instanceof Error ? err.message : String(err)
  }
}

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
    reach: {
      ...(form.byEmail && form.email ? { email: true } : {}),
      ...(form.chat ? { chat: form.chat } : {}),
      ...(form.byNtfy && form.topic ? { ntfy: form.topic } : {}),
    },
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
      <label v-if="form.pager || !delivery">Pager <input v-model.trim="form.pager" name="pager" maxlength="200" /></label>
      <fieldset v-if="delivery" class="wide reach">
        <legend>Channels</legend>
        <label class="check">
          <input v-model="form.byEmail" type="checkbox" name="by-email" :disabled="!delivery.email || !form.email" /> E-mail
          <button v-if="!delivery.email" type="button" class="plain" @click="emit('sending')">Set up</button>
        </label>
        <label>
          Chat
          <select v-model="form.chat" name="by-chat">
            <option value="">none</option>
            <option v-for="k in delivery.chats" :key="k.name" :value="k.name">{{ k.name }}</option>
          </select>
          <button v-if="delivery.chats.length === 0" type="button" class="plain" @click="emit('sending')">Set up</button>
        </label>
        <label class="check"><input v-model="form.byNtfy" type="checkbox" name="by-ntfy" /> ntfy</label>
        <div v-if="form.byNtfy && form.topic" class="ntfy">
          <QrCode :text="ntfyLink" label="ntfy subscription" />
          <p>
            <a :href="ntfyLink" target="_blank" rel="noopener">{{ ntfyLink }}</a><br />
            <button type="button" class="quiet" @click="testNtfy">Test</button> <span v-if="tested" class="by" role="status">{{ tested }}</span>
          </p>
        </div>
      </fieldset>
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
        {{ delivery ? 'Other host commands' : 'Host commands' }}
        <select v-model="form.hostCommands" name="host-commands" multiple :required="!reached">
          <option v-for="n in commands" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <label>
        {{ delivery ? 'Other service commands' : 'Service commands' }}
        <select v-model="form.serviceCommands" name="service-commands" multiple :required="!reached">
          <option v-for="n in commands" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <template v-if="state.extras">
        <label>
          Digest
          <select v-model="form.digest" name="digest">
            <option value="">off</option>
            <option v-for="n in commands" :key="n" :value="n">{{ n }}</option>
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
