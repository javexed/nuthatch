// Notifications pushed to browsers where nuthatch is installed, and sent
// the other ways a contact is reached (delivery.ts).
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

import type { Reach } from '@nuthatch/api'
import type { Backend } from './backend.ts'
import { type KeptDelivery, NO_DELIVERY, anyWay, deliver } from './delivery.ts'
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
  // The engines give a log line as it is in the log file, its time in
  // front: `[1700000000] SERVICE NOTIFICATION: ...`.
  const match = message.replace(/^\[\d+\] /, '').match(/^(HOST|SERVICE) NOTIFICATION: (.*)$/s)
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

/**
 * Several notices that came together, as one message: a switch that goes
 * down is not thirty messages on a phone.
 */
export function digestOf(backend: string, notices: Notice[]): Message {
  const problems = notices.filter((n) => bad(n.state)).length
  const rest = notices.length - problems
  const parts = [
    problems > 0 ? `${problems} problem${problems === 1 ? '' : 's'}` : '',
    rest > 0 ? (rest === 1 ? '1 recovery' : `${rest} recoveries`) : '',
  ].filter(Boolean)
  const lines = notices.slice(0, 6).map((n) => `${n.service === '' ? n.host : `${n.host} / ${n.service}`} is ${n.state}`)
  if (notices.length > 6) lines.push(`and ${notices.length - 6} more`)
  return {
    title: `${backend}: ${parts.join(', ')}`,
    body: lines.join('\n').slice(0, 600),
    url: 'problems',
    tag: `${backend}/digest`,
  }
}

const bad = (state: string) => !/^(OK|UP|RECOVERY)/.test(state) && !/\((OK|UP)\)/.test(state)

/** How long after its time a notification may reach the log, in seconds. */
const LAG = 60

export class Pusher {
  private readonly store: Store
  private readonly subject: string
  private readonly fetcher: typeof fetch
  readonly keys: ServerKeys
  /** nuthatch's own address, for links in mail, chat and ntfy: the subject, when it is one. */
  readonly base: string | undefined

  /** `subject`: who runs this server, as push services ask: mailto: or https:. */
  constructor(store: Store, subject: string, backends: Backend[], every = 5000, fetcher: typeof fetch = fetch) {
    this.store = store
    this.subject = subject
    this.fetcher = fetcher
    this.base = subject.startsWith('https://') ? subject : undefined
    // The server's keys are made once and kept: browsers subscribe to them.
    const kept = store.pref('', 'push.keys')
    this.keys = kept ? (JSON.parse(kept) as ServerKeys) : newServerKeys()
    if (!kept) store.setPref('', 'push.keys', JSON.stringify(this.keys))
    if (every > 0) for (const backend of backends) void this.watch(backend, every)
  }

  /** How mail, chat and ntfy are sent, as kept. */
  delivery(): KeptDelivery {
    const kept = this.store.pref('', 'delivery')
    return kept ? { ...NO_DELIVERY, ...(JSON.parse(kept) as KeptDelivery) } : NO_DELIVERY
  }

  setDelivery(kept: KeptDelivery): void {
    this.store.setPref('', 'delivery', JSON.stringify(kept))
  }

  /** A contact's other ways, and their address when mail is one. */
  async toContact(backend: Backend, contact: string, message: Message, urgent: boolean): Promise<string[]> {
    const body = this.store.reachOf(backend.name, contact)
    const reach = body ? (JSON.parse(body) as Reach) : undefined
    if (!anyWay(reach)) return []
    let email: string | undefined
    if (reach?.email) {
      const rows = await backend.query(`GET contacts\nColumns: email\nFilter: name = ${contact}`)
      email = String(rows[0]?.[0] ?? '') || undefined
      if (!email) return ['e-mail: the contact has no e-mail address']
    }
    return deliver(this.delivery(), reach as Reach, email, message, urgent, this.base, this.fetcher)
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

  /** The notifications a backend logged from `since` on that were not seen
   * yet, passed on. The answer is where the next pass starts: the newest
   * seen, or, when nothing came, a little before now, so that the window
   * does not grow for as long as nothing is notified. */
  async pass(backend: Backend, since: number, seen: Set<string>, now = Date.now() / 1000): Promise<number> {
    const rows = await backend.query(`GET log\nColumns: time message\nFilter: time >= ${since}\nFilter: class = 3`)
    let latest = since
    // What this pass found, by contact: one notice is told as it is,
    // several as one message.
    const found = new Map<string, Notice[]>()
    for (const [time, message] of rows as [number, string][]) {
      // Before the window: passed on already, or never news.
      if (time < since) continue
      latest = Math.max(latest, time)
      const notice = parseNotice(String(message))
      if (!notice) continue
      // A contact with two notification commands is told once.
      const key = `${time}|${notice.contact}|${notice.host}|${notice.service}|${notice.state}`
      if (seen.has(key)) continue
      seen.add(key)
      found.set(notice.contact, [...(found.get(notice.contact) ?? []), notice])
    }
    for (const [contact, notices] of found) {
      const message = notices.length === 1 ? messageOf(backend.name, notices[0] as Notice) : digestOf(backend.name, notices)
      const urgent = notices.some((n) => bad(n.state))
      void this.toUser(contact, message, urgent).catch((err: unknown) => console.error(`push ${contact}: ${err instanceof Error ? err.message : String(err)}`))
      void this.toContact(backend, contact, message, urgent)
        .then((failed) => failed.forEach((f) => console.error(`notify ${backend.name}/${contact}: ${f}`)))
        .catch((err: unknown) => console.error(`notify ${backend.name}/${contact}: ${err instanceof Error ? err.message : String(err)}`))
    }
    // A line is in the log a moment after its time: LAG back from now
    // is still looked at again.
    const next = Math.max(latest, Math.floor(now) - LAG)
    // What is older than where the next pass starts cannot come again.
    for (const key of seen) if (Number(key.split('|')[0]) < next) seen.delete(key)
    return next
  }

  private async watch(backend: Backend, every: number): Promise<void> {
    // From now: what was logged before nuthatch started is not news.
    let since = Math.floor(Date.now() / 1000)
    const seen = new Set<string>()
    let failing = false
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, every).unref())
      try {
        if (!this.store.anyPush() && !this.store.anyReach()) {
          since = Math.floor(Date.now() / 1000)
          continue
        }
        since = await this.pass(backend, since, seen)
        failing = false
      } catch (err) {
        // The engine away, or the store: said once, and the next turn tries again.
        if (!failing) console.error(`notify ${backend.name}: ${err instanceof Error ? err.message : String(err)}`)
        failing = true
      }
    }
  }
}
