// Notifications pushed to browsers where nuthatch is installed.
//
// The engine decides who is notified of what and when: its contacts,
// their notification periods and options, acknowledgements and downtimes.
// nuthatch only passes on what the engine wrote in its log as a
// notification to a contact, to the browsers that user subscribed. So a
// contact needs a notification command for anything to be pushed; any
// command will do.
//
// Only this nuthatch's own backends are watched: a site's notifications
// are pushed by that site's nuthatch, to those subscribed there.

import type { Backend } from './backend.ts'
import type { Store } from './store.ts'
import { type Sent, type ServerKeys, type Subscription, newServerKeys, send } from './webpush.ts'

export interface Notice {
  contact: string
  host: string
  /** Empty for a host's. */
  service: string
  /** As the engine wrote it: CRITICAL, UP, "ACKNOWLEDGEMENT (WARNING)", ... */
  state: string
  output: string
}

/** A notification line of the log: who was told what. Not one: null. */
export function parseNotice(message: string): Notice | null {
  const match = message.match(/^(HOST|SERVICE) NOTIFICATION: (.*)$/s)
  if (!match) return null
  const fields = (match[2] ?? '').split(';')
  // contact;host;[service;]state;command;output[;author;comment]
  const service = match[1] === 'SERVICE'
  const [contact = '', host = '', third = '', fourth = ''] = fields
  const state = service ? fourth : third
  const output = fields[service ? 5 : 4] ?? ''
  if (contact === '' || host === '' || state === '') return null
  return { contact, host, service: service ? third : '', state, output }
}

export interface Message {
  title: string
  body: string
  /** Where a tap leads, from the interface's root. */
  url: string
  /** A newer message with the same tag replaces the older on the device. */
  tag: string
}

export function messageOf(backend: string, notice: Notice): Message {
  const what = notice.service === '' ? notice.host : `${notice.host} / ${notice.service}`
  const enc = encodeURIComponent
  return {
    title: `${what} is ${notice.state}`,
    body: notice.output.slice(0, 300),
    url: notice.service === '' ? `host/${enc(backend)}/${enc(notice.host)}` : `service/${enc(backend)}/${enc(notice.host)}/${enc(notice.service)}`,
    tag: `${backend}/${notice.host}/${notice.service}`,
  }
}

const bad = (state: string) => !/^(OK|UP|RECOVERY)/.test(state) && !/\((OK|UP)\)/.test(state)

export class Pusher {
  private readonly store: Store
  private readonly subject: string
  private readonly fetcher: typeof fetch
  readonly keys: ServerKeys

  /** `subject`: who runs this server, as push services ask: mailto: or https:. */
  constructor(store: Store, subject: string, backends: Backend[], every = 5000, fetcher: typeof fetch = fetch) {
    this.store = store
    this.subject = subject
    this.fetcher = fetcher
    // The server's keys are made once and kept: browsers subscribe to them.
    const kept = store.pref('', 'push.keys')
    this.keys = kept ? (JSON.parse(kept) as ServerKeys) : newServerKeys()
    if (!kept) store.setPref('', 'push.keys', JSON.stringify(this.keys))
    if (every > 0) for (const backend of backends) void this.watch(backend, every)
  }

  /** Sends a message to all of a user's browsers; forgets those that are gone. */
  async toUser(user: string, message: Message, urgent: boolean): Promise<Record<Sent, number>> {
    const counts: Record<Sent, number> = { sent: 0, gone: 0, failed: 0 }
    await Promise.all(
      this.store.pushOf(user).map(async (row) => {
        const subscription: Subscription = { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }
        const result = await send(subscription, JSON.stringify(message), this.keys, this.subject, urgent, this.fetcher)
        counts[result]++
        if (result === 'gone') this.store.removePush(row.endpoint)
      }),
    )
    return counts
  }

  /** The notifications a backend logged from `since` on that were not seen yet, passed on. */
  async pass(backend: Backend, since: number, seen: Set<string>): Promise<number> {
    const rows = await backend.query(`GET log\nColumns: time message\nFilter: time >= ${since}\nFilter: class = 3`)
    let latest = since
    for (const [time, message] of rows as [number, string][]) {
      latest = Math.max(latest, time)
      const notice = parseNotice(String(message))
      if (!notice) continue
      // A contact with two notification commands is told once.
      const key = `${time}|${notice.contact}|${notice.host}|${notice.service}|${notice.state}`
      if (seen.has(key)) continue
      seen.add(key)
      void this.toUser(notice.contact, messageOf(backend.name, notice), bad(notice.state))
    }
    // What is older than the newest second cannot come again.
    for (const key of seen) if (Number(key.split('|')[0]) < latest) seen.delete(key)
    return latest
  }

  private async watch(backend: Backend, every: number): Promise<void> {
    // From now: what was logged before nuthatch started is not news.
    let since = Math.floor(Date.now() / 1000)
    const seen = new Set<string>()
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, every).unref())
      if (!this.store.anyPush()) {
        since = Math.floor(Date.now() / 1000)
        continue
      }
      since = await this.pass(backend, since, seen).catch(() => since)
    }
  }
}
