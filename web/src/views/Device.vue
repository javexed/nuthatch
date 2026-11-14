<script setup lang="ts">
// This device: whether the engine's notifications are pushed to it. The
// engine decides what you are notified of, as a contact; here a browser
// is only added to where those notifications go.
import type { PushState } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onMounted, ref } from 'vue'
import { ago } from '../lib/format'
import { api, useSession } from '../stores/session'

const session = useSession()
const state = ref<PushState | null>(null)
const mine = ref<string | null>(null)
const busy = ref(false)
const notice = ref('')
const error = ref('')

const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const blocked = ref(supported && Notification.permission === 'denied')
const here = computed(() => state.value?.devices.some((d) => d.endpoint === mine.value) ?? false)

function fail(err: unknown) {
  error.value = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'The server cannot be reached.'
}

async function load() {
  try {
    state.value = await api.notifications()
    if (supported) mine.value = (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription())?.endpoint ?? null
  } catch (err) {
    fail(err)
  }
}
onMounted(load)

/** A name for this browser, for the list. */
function deviceName(): string {
  const agent = navigator.userAgent
  const system = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iPhone or iPad' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : 'a device'
  const browser = /Firefox\//.test(agent) ? 'Firefox' : /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'a browser'
  return `${browser} on ${system}`
}

async function turnOn() {
  if (!state.value?.key) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const permission = await Notification.requestPermission()
    blocked.value = permission === 'denied'
    if (permission !== 'granted') return
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: state.value.key })
    await api.subscribeNotifications(subscription.toJSON(), deviceName())
    await load()
    notice.value = 'Notifications are on for this device.'
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}

async function turnOff(endpoint: string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (endpoint === mine.value) await (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription())?.unsubscribe()
    await api.removeNotifications(endpoint)
    await load()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}

async function test() {
  busy.value = true
  error.value = ''
  try {
    const counts = await api.testNotifications()
    notice.value = counts.sent > 0 ? `A test was sent to ${counts.sent} device${counts.sent === 1 ? '' : 's'}.` : 'The test could not be sent.'
    if (counts.gone > 0) await load()
  } catch (err) {
    fail(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h1>This device</h1>
  <p class="by">Logged in as <strong>{{ session.session?.user }}</strong><template v-if="session.session?.by_tailnet">, by Tailscale</template>.</p>
  <section class="card device" aria-label="Notifications">
    <h2>Notifications</h2>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <template v-if="state">
      <p v-if="!state.enabled" class="none">Notifications are not set up on this server (<code>[notifications]</code> in its config).</p>
      <template v-else>
        <p>
          What the engine notifies you of, as the contact <strong>{{ session.session?.user }}</strong>, is also sent to the devices listed here: problems,
          recoveries and the rest, as your contact is set up there.
        </p>
        <p v-if="!supported" class="warning-text">
          This browser cannot receive them. On an iPhone or iPad, add nuthatch to the Home Screen first and open it from there.
        </p>
        <p v-else-if="blocked" class="warning-text">Notifications from this site are blocked in this browser's settings.</p>
        <p v-else-if="!here"><button type="button" :disabled="busy" @click="turnOn">Notify this device</button></p>
        <ul v-if="state.devices.length > 0" class="devices">
          <li v-for="device in state.devices" :key="device.endpoint">
            <span>
              <strong>{{ device.name }}</strong><template v-if="device.endpoint === mine"> (this one)</template>
              <span class="by"> · added {{ ago(device.created) }}</span>
            </span>
            <button type="button" class="plain" :disabled="busy" @click="turnOff(device.endpoint)">Take out</button>
          </li>
        </ul>
        <p v-else class="none">No device yet.</p>
        <p v-if="state.devices.length > 0"><button type="button" class="quiet" :disabled="busy" @click="test">Send a test</button></p>
      </template>
    </template>
  </section>
</template>
