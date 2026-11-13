// Telling the browser that something changed.
//
// While at least one browser listens, each backend is asked for a few
// sums that move when states, acknowledgements, downtimes or comments do.
// When they moved, every listener gets `changed` with `{"backend": name}`,
// and `backend` with `{"name", "ok"}` when a backend stops or starts
// answering.
//
// An engine does not push anything over Livestatus, but it can hold an
// answer back until something happens (`WaitTrigger`). So an engine that
// does is asked the moment it says a state changed, and every two
// seconds anyway, for what it does not count as one; an engine that does
// not is asked every two seconds, and that is all.
//
// After someone asked for a check, its result is waited for the same way
// for a while: a result that changes no state moves no sum, and the
// browser is told `changed` when the engine says a result came in.
//
// The events carry nothing of what changed: the browser asks again
// through the queries, which decide what this user may see. Results that
// change no state (a new output, a new last check) send nothing; the
// browser reads those on a timer of its own.
//
// A new line in the log counts as a change too (a notification, a
// command someone sent), so that a page showing the log shows it at once.

import type { Backend } from './backend.ts'

const OBJECTS = [
  'Stats: max last_state_change',
  'Stats: max last_hard_state_change',
  'Stats: sum state',
  'Stats: sum acknowledged',
  'Stats: sum scheduled_downtime_depth',
  'Stats: sum notifications_enabled',
  'Stats: sum active_checks_enabled',
  'Stats: state >= 0',
].join('\n')
const ENTRIES = 'Stats: max id\nStats: id >= 0'

/** What a backend looks like now, as text to compare with last time. */
async function fingerprint(backend: Backend): Promise<string> {
  // The log's lines since the hour began: a number that only grows, but
  // for once an hour.
  const hour = Math.floor(Date.now() / 3_600_000) * 3600
  const requests = [
    'GET status\nColumns: program_start',
    `GET hosts\n${OBJECTS}`,
    `GET services\n${OBJECTS}`,
    `GET comments\n${ENTRIES}`,
    `GET downtimes\n${ENTRIES}`,
    `GET log\nFilter: time >= ${hour}\nStats: time >= 0`,
  ]
  let out = ''
  for (const request of requests) out += JSON.stringify(await backend.query(request))
  return out
}

export type Listener = (event: string, data: string) => void

/** After a wake, the engine is given this long before the next question. */
const SETTLE = 100
/** While a check's result is waited for, `changed` is sent this often at most. */
const CHECK_PACE = 400
/** How long the result of a check that was asked for is waited for. */
const AWAIT_CHECK = 45_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms).unref())

export class Events {
  private readonly listeners = new Set<Listener>()
  /** Until when a backend's check results are waited for. */
  private readonly awaited = new Map<string, number>()
  /** The loops that rest while nobody listens. */
  private readonly idle: (() => void)[] = []

  constructor(backends: Backend[], every = 2000) {
    // One loop per backend: one that does not answer holds up no other.
    for (const backend of backends) void this.watch(backend, every)
  }

  /** Listens until the answer is called. */
  listen(listener: Listener): () => void {
    this.listeners.add(listener)
    for (const wake of this.idle.splice(0)) wake()
    return () => this.listeners.delete(listener)
  }

  /** A check was asked of this backend: its result is news, whatever it says. */
  expectCheck(backend: string): void {
    this.awaited.set(backend, Date.now() + AWAIT_CHECK)
  }

  /** Passes on an event of a site that another nuthatch watches. */
  forward(event: string, data: unknown): void {
    this.send(event, data)
  }

  private send(event: string, data: unknown): void {
    for (const listener of this.listeners) listener(event, JSON.stringify(data))
  }

  private async watch(backend: Backend, every: number): Promise<void> {
    let last: string | null | undefined
    for (;;) {
      // Nobody listens: no engine is asked anything until someone does.
      if (this.listeners.size === 0) {
        last = undefined
        await new Promise<void>((resolve) => this.idle.push(resolve))
      }
      const started = Date.now()
      const checks = Date.now() < (this.awaited.get(backend.name) ?? 0)
      let woken = false
      if (backend.wait) {
        // One that cannot be asked now is found out below.
        woken = (await backend.wait(checks ? 'check' : 'state', every).catch(() => 'unsupported')) === 'woken'
      }
      // Never faster than this, however often the engine wakes.
      const left = (woken ? (checks ? CHECK_PACE : SETTLE) : every) - (Date.now() - started)
      if (left > 0) await sleep(left)
      if (this.listeners.size === 0) continue
      // null: not answering.
      const now = await fingerprint(backend).catch(() => null)
      if (last !== undefined) {
        if ((last === null) !== (now === null)) this.send('backend', { name: backend.name, ok: now !== null })
        else if (last !== now || (woken && checks)) this.send('changed', { backend: backend.name })
      }
      last = now
    }
  }
}
