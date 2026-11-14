<script setup lang="ts">
// One host or one service: its state and what the last check said, what
// was done about it, and what can be done.
import type { Command } from '@nuthatch/api'
import { ApiError } from '@nuthatch/api'
import { computed, ref, watch } from 'vue'
import CommandDialog, { type Action } from '../components/CommandDialog.vue'
import EventLog from '../components/EventLog.vue'
import PerfGraphs from '../components/PerfGraphs.vue'
import PushInfo from '../components/PushInfo.vue'
import StateBadge from '../components/StateBadge.vue'
import StatusList from '../components/StatusList.vue'
import { type Target, deleteComment, deleteDowntime, recheck, removeAcknowledgement, setChecks, setNotifications } from '../lib/commands'
import { ago, dateTime, duration } from '../lib/format'
import { fraction, parsePerfdata } from '../lib/perfdata'
import { useLive, useLoader } from '../stores/live'
import { api, useSession } from '../stores/session'

const props = defineProps<{ backend: string; host: string; service?: string }>()
const session = useSession()
const live = useLive()
const kind = computed(() => (props.service === undefined ? 'host' : 'service'))
const target = computed<Target>(() => ({ backend: props.backend, host: props.host, service: props.service }))
const canCommand = computed(() => !session.has('read_only'))

const COLUMNS = ['state', 'has_been_checked', 'plugin_output', 'long_plugin_output', 'perf_data', 'last_check', 'next_check', 'last_state_change',
  'current_attempt', 'max_check_attempts', 'state_type', 'acknowledged', 'scheduled_downtime_depth', 'notifications_enabled',
  'active_checks_enabled', 'is_flapping', 'latency', 'execution_time', 'groups', 'contacts', 'notes'] as const
const HOST_COLUMNS = ['alias', 'address'] as const

/** The filter lines that pick this object in a table that names both. */
const pick = computed(() =>
  props.service === undefined
    ? [`Filter: host_name = ${props.host}`, 'Filter: is_service = 0']
    : [`Filter: host_name = ${props.host}`, `Filter: service_description = ${props.service}`, 'Filter: is_service = 1'],
)

const { data, error, loading } = useLoader(async () => {
  const object =
    props.service === undefined
      ? api.query({ table: 'hosts', columns: [...COLUMNS, ...HOST_COLUMNS], headers: [`Filter: name = ${props.host}`], backends: [props.backend] })
      : api.query({
          table: 'services',
          columns: [...COLUMNS, 'host_state', 'host_has_been_checked'],
          headers: [`Filter: host_name = ${props.host}`, `Filter: description = ${props.service}`],
          backends: [props.backend],
        })
  const comments = api.query({
    table: 'comments',
    columns: ['id', 'author', 'comment', 'entry_time', 'entry_type'],
    headers: pick.value,
    sort: [{ column: 'entry_time', desc: true }],
    backends: [props.backend],
  })
  const downtimes = api.query({
    table: 'downtimes',
    columns: ['id', 'author', 'comment', 'start_time', 'end_time', 'fixed', 'duration'],
    headers: pick.value,
    sort: [{ column: 'start_time' }],
    backends: [props.backend],
  })
  const [o, c, d] = await Promise.all([object, comments, downtimes])
  const why = o.errors[props.backend] ?? c.errors[props.backend] ?? d.errors[props.backend]
  if (why !== undefined) throw new ApiError(502, why)
  return { object: o.rows[0] as Record<string, unknown> | undefined, comments: c.rows, downtimes: d.rows }
}, [() => props.backend, () => props.host, () => props.service])

const object = computed(() => data.value?.object)
const perf = computed(() => parsePerfdata(String(object.value?.perf_data ?? '')))
const problem = computed(() => object.value !== undefined && Number(object.value.state) !== 0 && object.value.has_been_checked !== 0)
const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '')
const KINDS: Record<number, string> = { 1: 'Comment', 2: 'Downtime', 3: 'Flapping', 4: 'Acknowledgement' }

// The last day's alerts, and whatever comes while the page is open.
const dayAgo = Date.now() / 1000 - 86400
const farAhead = Date.now() / 1000 + 365 * 86400

const dialog = ref<Action | null>(null)
const notice = ref('')

// A check that was asked for: waited for, and shown when it is back.
const checking = computed(() => live.checking(target.value, Number(object.value?.last_check ?? 0)))
const flash = ref(false)
watch(object, (now, before) => {
  if (now === undefined) return
  const back = live.arrived(target.value, Number(now.last_check ?? 0))
  if (!back && (before === undefined || before.state === now.state)) return
  flash.value = true
  setTimeout(() => (flash.value = false), 1600)
})

async function checkNow() {
  const last = Number(object.value?.last_check ?? 0)
  if (await send(recheck(target.value), 'Asked for a check.')) live.expectCheck(target.value, last)
}

async function send(command: Command, done: string): Promise<boolean> {
  let sent = true
  try {
    await api.command(command)
    notice.value = done
  } catch (err) {
    sent = false
    notice.value = err instanceof ApiError ? err.message : 'Server unreachable'
  }
  live.nudge()
  return sent
}
</script>

<template>
  <nav class="crumbs" aria-label="Where this is">
    <RouterLink :to="{ name: kind === 'host' ? 'hosts' : 'services' }">{{ kind === 'host' ? 'Hosts' : 'Services' }}</RouterLink>
    <template v-if="service !== undefined">
      <span>›</span>
      <RouterLink :to="{ name: 'host', params: { backend, host } }">{{ host }}</RouterLink>
    </template>
  </nav>
  <h1>{{ service ?? host }} <span class="backend">{{ backend }}</span></h1>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-else-if="!loading && !object" class="none">Not found</p>

  <template v-if="object">
    <section :class="['card', { flash }]">
      <div class="headline">
        <StateBadge :kind="kind" :state="object.state" :checked="object.has_been_checked" />
        <span v-if="object.last_state_change">for {{ duration(Date.now() / 1000 - Number(object.last_state_change)) }}</span>
        <span v-if="object.state_type === 0 && problem" class="mark" title="Not confirmed yet by enough checks">
          soft, attempt {{ object.current_attempt }} of {{ object.max_check_attempts }}
        </span>
        <span v-if="object.acknowledged" class="mark">acknowledged</span>
        <span v-if="Number(object.scheduled_downtime_depth) > 0" class="mark">in a downtime</span>
        <span v-if="object.is_flapping" class="mark">flapping</span>
      </div>
      <p class="output">{{ object.plugin_output || 'No output yet.' }}</p>
      <pre v-if="object.long_plugin_output" class="long">{{ String(object.long_plugin_output).replace(/\\n/g, '\n') }}</pre>
      <div v-if="canCommand" class="actions" role="toolbar" aria-label="Actions">
        <button type="button" :disabled="checking" @click="checkNow">
          <span v-if="checking" class="spinner" aria-hidden="true"></span>{{ checking ? 'Checking…' : 'Check now' }}
        </button>
        <button v-if="problem && !object.acknowledged" type="button" class="quiet" @click="dialog = 'acknowledge'">Acknowledge</button>
        <button v-if="object.acknowledged" type="button" class="quiet" @click="send(removeAcknowledgement(target), 'Acknowledgement removed.')">
          Remove acknowledgement
        </button>
        <button type="button" class="quiet" @click="dialog = 'downtime'">Downtime</button>
        <button type="button" class="quiet" @click="dialog = 'comment'">Comment</button>
        <button
          type="button"
          class="quiet"
          @click="send(setNotifications(target, object.notifications_enabled === 0), object.notifications_enabled === 0 ? 'Notifications turned on.' : 'Notifications turned off.')"
        >
          {{ object.notifications_enabled === 0 ? 'Turn notifications on' : 'Turn notifications off' }}
        </button>
        <button
          type="button"
          class="quiet"
          @click="send(setChecks(target, object.active_checks_enabled === 0), object.active_checks_enabled === 0 ? 'Checks turned on.' : 'Checks turned off.')"
        >
          {{ object.active_checks_enabled === 0 ? 'Turn checks on' : 'Turn checks off' }}
        </button>
      </div>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    </section>

    <section class="card">
      <h2>Details</h2>
      <dl class="facts">
        <template v-if="kind === 'host'">
          <dt>Alias</dt><dd>{{ object.alias }}</dd>
          <dt>Address</dt><dd>{{ object.address }}</dd>
        </template>
        <template v-else>
          <dt>Host</dt>
          <dd>
            <RouterLink :to="{ name: 'host', params: { backend, host } }">{{ host }}</RouterLink>
            <StateBadge kind="host" :state="object.host_state" :checked="object.host_has_been_checked" />
          </dd>
        </template>
        <dt>Last check</dt><dd>{{ dateTime(Number(object.last_check)) }} ({{ ago(Number(object.last_check)) }})</dd>
        <dt>Next check</dt><dd>{{ object.active_checks_enabled === 0 ? 'checks are off' : dateTime(Number(object.next_check)) }}</dd>
        <dt>Last change</dt><dd>{{ dateTime(Number(object.last_state_change)) }}</dd>
        <dt>Check took</dt><dd>{{ Number(object.execution_time).toFixed(3) }} s, started {{ Number(object.latency).toFixed(3) }} s late</dd>
        <dt>Notifications</dt><dd>{{ object.notifications_enabled === 0 ? 'off' : 'on' }}</dd>
        <dt>Groups</dt><dd>{{ list(object.groups) || 'none' }}</dd>
        <dt>Contacts</dt><dd>{{ list(object.contacts) || 'none' }}</dd>
        <template v-if="object.notes"><dt>Notes</dt><dd>{{ object.notes }}</dd></template>
      </dl>
    </section>

    <PushInfo v-if="service !== undefined && (session.has('config_edit') || session.has('configuration_information'))" :key="`${backend}/${host}/${service}`" :backend="backend" :host="host" :service="service" />
    <PerfGraphs :backend="backend" :host="host" :service="service" />
    <section v-if="perf.length > 0" class="card">
      <h2>Performance data</h2>
      <table class="perf">
        <thead><tr><th>Value</th><th></th><th>Warning</th><th>Critical</th><th></th></tr></thead>
        <tbody>
          <tr v-for="p in perf" :key="p.label">
            <th scope="row">{{ p.label }}</th>
            <td>{{ p.value }}{{ p.unit }}</td>
            <td>{{ p.warn }}</td>
            <td>{{ p.crit }}</td>
            <td><meter v-if="fraction(p) !== null" :value="fraction(p) ?? 0" :aria-label="`${p.label}: how full`"></meter></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="data && data.downtimes.length > 0" class="card">
      <h2>Downtimes</h2>
      <ul class="entries">
        <li v-for="d in data.downtimes" :key="String(d.id)">
          <div>
            <strong>{{ dateTime(Number(d.start_time)) }} to {{ dateTime(Number(d.end_time)) }}</strong>
            <span v-if="d.fixed === 0"> (flexible, {{ duration(Number(d.duration)) }})</span>
            <p>{{ d.comment }} <span class="by">{{ d.author }}</span></p>
          </div>
          <button v-if="canCommand" type="button" class="plain" @click="send(deleteDowntime(backend, Number(d.id), kind === 'service'), 'Downtime removed.')">Remove</button>
        </li>
      </ul>
    </section>

    <section v-if="data && data.comments.length > 0" class="card">
      <h2>Comments</h2>
      <ul class="entries">
        <li v-for="c in data.comments" :key="String(c.id)">
          <div>
            <strong>{{ KINDS[Number(c.entry_type)] ?? 'Comment' }}</strong> <span class="by">{{ c.author }}, {{ dateTime(Number(c.entry_time)) }}</span>
            <p>{{ c.comment }}</p>
          </div>
          <button v-if="canCommand" type="button" class="plain" @click="send(deleteComment(backend, Number(c.id), kind === 'service'), 'Comment deleted.')">Delete</button>
        </li>
      </ul>
    </section>

    <section class="card">
      <h2>History</h2>
      <EventLog :from="dayAgo" :to="farAhead" lines="alerts" :backend="backend" :host="host" :service="service ?? ''" :page-size="10" />
      <p class="more">
        <RouterLink :to="{ name: 'history', query: { backend, host, ...(service === undefined ? {} : { service }), range: '7d' } }">More history</RouterLink>
        ·
        <RouterLink :to="{ name: 'availability', query: { backend, host, ...(service === undefined ? {} : { of: 'services' }), range: '7d' } }">Availability</RouterLink>
      </p>
    </section>

    <section v-if="kind === 'host'">
      <h2>Services</h2>
      <StatusList kind="service" :backend="backend" :base="{ host }" empty="None" />
    </section>
    <CommandDialog v-if="dialog" :action="dialog" :targets="[target]" @close="dialog = null" />
  </template>
</template>
