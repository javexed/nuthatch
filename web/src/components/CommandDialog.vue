<script setup lang="ts">
// Acknowledging, scheduling a downtime or commenting, for one object or
// for several at once. Each command's outcome is shown by its object.
import type { Command } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, onMounted, ref } from 'vue'
import { type Target, acknowledge, comment, downtime, targetName } from '../lib/commands'
import { fromInput, toInput } from '../lib/format'
import { useLive } from '../stores/live'
import { api } from '../stores/session'

export type Action = 'acknowledge' | 'downtime' | 'comment'

const props = defineProps<{ action: Action; targets: Target[] }>()
const emit = defineEmits<{ close: [] }>()
const live = useLive()
const dialog = ref<HTMLDialogElement>()

const text = ref('')
const sticky = ref(true)
const notify = ref(true)
const persistent = ref(false)
const now = Math.floor(Date.now() / 1000)
const start = ref(toInput(now))
const end = ref(toInput(now + 2 * 3600))
const fixed = ref(true)
const hours = ref(2)
const withServices = ref(true)
const busy = ref(false)
const problem = ref('')
const failed = ref<{ name: string; why: string }[]>([])

const titles: Record<Action, string> = { acknowledge: 'Acknowledge', downtime: 'Schedule downtime', comment: 'Add comment' }
const anyHost = computed(() => props.targets.some((t) => t.service === undefined))
const subject = computed(() => (props.targets.length === 1 ? targetName(props.targets[0]!) : `${props.targets.length} objects`))

onMounted(() => dialog.value?.showModal())

function commandsFor(target: Target): Command[] {
  switch (props.action) {
    case 'acknowledge':
      return [acknowledge(target, { comment: text.value, sticky: sticky.value, notify: notify.value, persistent: persistent.value })]
    case 'comment':
      return [comment(target, text.value)]
    case 'downtime':
      return downtime(target, {
        comment: text.value,
        start: fromInput(start.value),
        end: fromInput(end.value),
        fixed: fixed.value,
        duration: Math.round(hours.value * 3600),
        withServices: withServices.value,
      })
  }
}

async function submit() {
  problem.value = ''
  if (props.action === 'downtime') {
    const [from, to] = [fromInput(start.value), fromInput(end.value)]
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      problem.value = 'The end must be after the start.'
      return
    }
  }
  busy.value = true
  failed.value = []
  for (const target of props.targets) {
    try {
      for (const command of commandsFor(target)) await api.command(command)
    } catch (err) {
      failed.value.push({ name: targetName(target), why: err instanceof ApiError ? err.message : 'The server cannot be reached.' })
    }
  }
  busy.value = false
  live.nudge()
  if (failed.value.length === 0) emit('close')
}
</script>

<template>
  <dialog ref="dialog" class="dialog" @close="emit('close')">
    <form @submit.prevent="submit">
      <h2>{{ titles[action] }}</h2>
      <p class="subject">{{ subject }}</p>
      <label>
        Comment
        <textarea v-model="text" name="comment" rows="2" required autofocus></textarea>
      </label>
      <template v-if="action === 'acknowledge'">
        <label class="check"><input v-model="sticky" type="checkbox" /> Until it recovers, not only until its state changes</label>
        <label class="check"><input v-model="notify" type="checkbox" /> Tell the contacts</label>
        <label class="check"><input v-model="persistent" type="checkbox" /> Keep the comment after the problem is over</label>
      </template>
      <template v-if="action === 'downtime'">
        <div class="pair">
          <label>Start <input v-model="start" name="start" type="datetime-local" required /></label>
          <label>End <input v-model="end" name="end" type="datetime-local" required /></label>
        </div>
        <label class="check"><input v-model="fixed" type="checkbox" /> Fixed: from the start to the end</label>
        <label v-if="!fixed">
          Flexible: begins with a problem in that time, and lasts this many hours
          <input v-model.number="hours" name="hours" type="number" min="0.1" step="0.1" required />
        </label>
        <label v-if="anyHost" class="check"><input v-model="withServices" type="checkbox" /> The host's services too</label>
      </template>
      <p v-if="problem" class="error" role="alert">{{ problem }}</p>
      <ul v-if="failed.length > 0" class="failed" role="alert">
        <li v-for="f in failed" :key="f.name"><strong>{{ f.name }}</strong>: {{ f.why }}</li>
      </ul>
      <div class="buttons">
        <button type="button" class="quiet" @click="dialog?.close()">{{ failed.length > 0 ? 'Close' : 'Cancel' }}</button>
        <button type="submit" :disabled="busy">{{ titles[action] }}</button>
      </div>
    </form>
  </dialog>
</template>
