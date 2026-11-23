<script setup lang="ts">
// How nuthatch sends what the engine notifies: mail, chat links, ntfy.
import type { ChatKind, DeliverySettings } from '@nuthatch/api'
import { reactive, ref } from 'vue'
import { api } from '../stores/session'

const props = defineProps<{ settings: DeliverySettings }>()
const emit = defineEmits<{ saved: [settings: DeliverySettings]; close: [] }>()

const KINDS: [ChatKind, string][] = [
  ['slack', 'Slack'],
  ['discord', 'Discord'],
  ['teams', 'Microsoft Teams'],
  ['google-chat', 'Google Chat'],
  ['mattermost', 'Mattermost'],
]
const e = props.settings.email
const form = reactive({
  mail: e !== undefined,
  host: e?.host ?? 'smtp.gmail.com',
  port: e?.port ?? 465,
  user: e?.user ?? '',
  password: '',
  from: e?.from ?? '',
  chats: props.settings.chats.map((c) => ({ ...c })),
  ntfy: props.settings.ntfy.server,
})
const hasPassword = ref(e?.has_password === true)
const testTo = ref(e?.user.includes('@') ? e.user : '')
const busy = ref(false)
const error = ref('')
const said = ref('')

function result(): DeliverySettings {
  return {
    ...(form.mail ? { email: { host: form.host.trim(), port: Number(form.port), user: form.user.trim(), from: form.from.trim(), has_password: hasPassword.value, password: form.password } } : {}),
    chats: form.chats.map((c) => ({ name: c.name.trim(), kind: c.kind, url: c.url.trim() })),
    ntfy: { server: form.ntfy.trim() },
  }
}

async function run(what: () => Promise<unknown>, done: string) {
  busy.value = true
  error.value = ''
  said.value = ''
  try {
    await what()
    said.value = done
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function save() {
  await run(async () => {
    const saved = await api.saveDelivery(result())
    form.password = ''
    hasPassword.value = saved.email?.has_password === true
    emit('saved', saved)
  }, 'Saved')
}
/** Saved first: a test sends by what is kept. */
const test = (kind: 'email' | 'chat', name = '') =>
  run(async () => {
    const saved = await api.saveDelivery(result())
    emit('saved', saved)
    form.password = ''
    hasPassword.value = saved.email?.has_password === true
    await api.testDelivery(kind === 'email' ? { kind, to: testTo.value.trim() } : { kind, name })
  }, 'Sent')
</script>

<template>
  <form class="delivery card" aria-label="Notification channels" @submit.prevent="save">
    <h2>Notification channels</h2>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-else-if="said" class="by" role="status">{{ said }}</p>

    <label class="check"><input v-model="form.mail" type="checkbox" name="mail" /> E-mail</label>
    <div v-if="form.mail" class="fields">
      <label>Server <input v-model.trim="form.host" name="mail-host" required autocapitalize="none" /></label>
      <label>
        Port
        <select v-model.number="form.port" name="mail-port">
          <option :value="465">465 (TLS)</option>
          <option :value="587">587 (STARTTLS)</option>
        </select>
      </label>
      <label>Login <input v-model.trim="form.user" name="mail-user" required autocapitalize="none" autocomplete="off" /></label>
      <label>
        {{ form.host === 'smtp.gmail.com' ? 'App password' : 'Password' }}
        <input v-model="form.password" name="mail-password" type="password" autocomplete="new-password" :required="!hasPassword" :placeholder="hasPassword ? 'kept' : ''" />
      </label>
      <label>From <input v-model.trim="form.from" name="mail-from" type="email" autocapitalize="none" :placeholder="form.user" /></label>
      <label>Test to <input v-model.trim="testTo" name="mail-test" type="email" autocapitalize="none" /></label>
      <p><button type="button" class="quiet" :disabled="busy || !testTo" @click="test('email')">Send test</button></p>
    </div>

    <h3>Chat</h3>
    <ul class="chats">
      <li v-for="(c, i) in form.chats" :key="i" class="fields">
        <label>Name <input v-model="c.name" :name="`chat-name-${i}`" required maxlength="40" /></label>
        <label>
          Kind
          <select v-model="c.kind" :name="`chat-kind-${i}`">
            <option v-for="[k, text] in KINDS" :key="k" :value="k">{{ text }}</option>
          </select>
        </label>
        <label class="wide">Webhook <input v-model.trim="c.url" :name="`chat-url-${i}`" type="url" required pattern="https://.*" autocomplete="off" /></label>
        <p class="row">
          <button type="button" class="quiet" :disabled="busy || !c.name || !c.url" @click="test('chat', c.name.trim())">Test</button>
          <button type="button" class="plain" :disabled="busy" @click="form.chats.splice(i, 1)">Remove</button>
        </p>
      </li>
    </ul>
    <p><button type="button" class="quiet" @click="form.chats.push({ name: '', kind: 'slack', url: '' })">Add a chat</button></p>

    <h3>ntfy</h3>
    <div class="fields">
      <label>Server <input v-model.trim="form.ntfy" name="ntfy-server" required autocapitalize="none" /></label>
    </div>

    <div class="buttons">
      <button type="button" class="quiet" :disabled="busy" @click="emit('close')">Close</button>
      <button type="submit" :disabled="busy">Save</button>
    </div>
  </form>
</template>
