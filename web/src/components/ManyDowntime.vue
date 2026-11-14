<script setup lang="ts">
// A downtime for every host, or every service, whose name fits a
// pattern: first which those are, then the downtime for each.
import { ApiError } from '@nuthatch/api'
import { onMounted, ref, watch } from 'vue'
import { fromInput, toInput } from '../lib/format'
import { useLive } from '../stores/live'
import { api, useSession } from '../stores/session'

const props = defineProps<{ kind: 'host' | 'service' }>()
const emit = defineEmits<{ close: [] }>()
const session = useSession()
const live = useLive()
const dialog = ref<HTMLDialogElement>()

const backends = (session.session?.backends ?? []).map((b) => b.name)
const backend = ref(backends[0] ?? '')
const hosts = ref('')
const services = ref('')
const comment = ref('')
const now = Math.floor(Date.now() / 1000)
const start = ref(toInput(now))
const end = ref(toInput(now + 2 * 3600))
const busy = ref(false)
const problem = ref('')
/** What fits, once looked for; null before. */
const matches = ref<string[][] | null>(null)
const done = ref(0)

onMounted(() => dialog.value?.showModal())
// What was found is of the pattern as it was then.
watch([backend, hosts, services], () => (matches.value = null))

function asked(dryRun: boolean) {
  return {
    backend: backend.value,
    hosts: hosts.value.trim(),
    services: props.kind === 'service' ? services.value.trim() : '',
    start: fromInput(start.value),
    end: fromInput(end.value),
    comment: comment.value.trim(),
    dry_run: dryRun,
  }
}

async function send(dryRun: boolean) {
  problem.value = ''
  const [from, to] = [fromInput(start.value), fromInput(end.value)]
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    problem.value = 'The end must be after the start.'
    return
  }
  busy.value = true
  try {
    const answer = await api.downtimeMany(asked(dryRun))
    if (dryRun) matches.value = answer.matches
    else {
      done.value = answer.matches.length
      live.nudge()
    }
  } catch (err) {
    problem.value = err instanceof ApiError ? err.message : 'The server cannot be reached.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <dialog ref="dialog" class="dialog many-downtime" @close="emit('close')">
    <form v-if="done === 0" @submit.prevent="send(matches === null || matches.length === 0)">
      <h2>Downtime for many {{ kind }}s</h2>
      <label v-if="backends.length > 1">
        Backend
        <select v-model="backend" name="backend">
          <option v-for="name in backends" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label>
        Hosts
        <input v-model="hosts" name="hosts" required maxlength="63" autocapitalize="none" spellcheck="false" placeholder="web*, or @group for a host group" autofocus />
      </label>
      <label v-if="kind === 'service'">
        Services on them
        <input v-model="services" name="services" required maxlength="63" autocapitalize="none" spellcheck="false" placeholder="backup, disk *, or * for all" />
      </label>
      <p class="by">* stands for any run of characters, ? for any one.</p>
      <div class="pair">
        <label>Start <input v-model="start" name="start" type="datetime-local" required /></label>
        <label>End <input v-model="end" name="end" type="datetime-local" required /></label>
      </div>
      <label>
        Comment
        <textarea v-model="comment" name="comment" rows="2" required></textarea>
      </label>
      <div v-if="matches !== null" class="matches" role="status">
        <p v-if="matches.length === 0" class="warning-text">Nothing fits.</p>
        <template v-else>
          <p><strong>{{ matches.length }}</strong> {{ matches.length === 1 ? 'fits' : 'fit' }}:</p>
          <ul>
            <li v-for="m in matches.slice(0, 12)" :key="m.join('/')">{{ m.join(' / ') }}</li>
            <li v-if="matches.length > 12" class="by">and {{ matches.length - 12 }} more</li>
          </ul>
        </template>
      </div>
      <p v-if="problem" class="error" role="alert">{{ problem }}</p>
      <div class="buttons">
        <button type="button" class="quiet" @click="dialog?.close()">Cancel</button>
        <button type="submit" :disabled="busy">
          {{ matches !== null && matches.length > 0 ? `Schedule downtime for ${matches.length}` : 'See what fits' }}
        </button>
      </div>
    </form>
    <div v-else class="done">
      <h2>Downtime scheduled</h2>
      <p role="status">{{ done }} {{ kind }}{{ done === 1 ? ' is' : 's are' }} in a downtime from {{ start.replace('T', ' ') }} to {{ end.replace('T', ' ') }}.</p>
      <div class="buttons"><button type="button" @click="dialog?.close()">Close</button></div>
    </div>
  </dialog>
</template>
