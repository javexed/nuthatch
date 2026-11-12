// Telling the browser that something changed.
//
// Neither Naemon nor checkd pushes anything over Livestatus, so while at
// least one browser listens, each backend is asked every two seconds for
// a few sums that move when states, acknowledgements, downtimes or
// comments do. When they moved, every listener gets `changed` with
// `{"backend": name}`, and `backend` with `{"name", "ok"}` when a backend
// stops or starts answering.
//
// The events carry nothing of what changed: the browser asks again
// through the queries, which decide what this user may see. Results that
// change no state (a new output, a new last check) send nothing; the
// browser reads those on a timer of its own.

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
  const requests = ['GET status\nColumns: program_start', `GET hosts\n${OBJECTS}`, `GET services\n${OBJECTS}`, `GET comments\n${ENTRIES}`, `GET downtimes\n${ENTRIES}`]
  let out = ''
  for (const request of requests) out += JSON.stringify(await backend.query(request))
  return out
}

export type Listener = (event: string, data: string) => void

export class Events {
  private readonly listeners = new Set<Listener>()

  constructor(backends: Backend[], every = 2000) {
    // One loop per backend: one that does not answer holds up no other.
    for (const backend of backends) void this.watch(backend, every)
  }

  /** Listens until the answer is called. */
  listen(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
      await new Promise((resolve) => setTimeout(resolve, every).unref())
      if (this.listeners.size === 0) {
        last = undefined
        continue
      }
      // null: not answering.
      const now = await fingerprint(backend).catch(() => null)
      if (last !== undefined) {
        if ((last === null) !== (now === null)) this.send('backend', { name: backend.name, ok: now !== null })
        else if (last !== now) this.send('changed', { backend: backend.name })
      }
      last = now
    }
  }
}
