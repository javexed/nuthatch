// How a notification reaches a contact besides the browsers they installed
// nuthatch in: e-mail, a chat channel, or ntfy. The engine still decides who
// is told what and when; nuthatch passes on what it logged (push.ts).
//
// How to send is set once, by config_edit (`DeliverySettings`); how each
// contact is reached is theirs (`Reach`), kept in nuthatch's store. The
// mail password is kept in the store and never sent back to a browser.

import { randomBytes } from 'node:crypto'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { ChatKind, DeliverySettings, Reach } from '@nuthatch/api'
import { Refused as Refusal } from './policy.ts'
import type { Message } from './push.ts'

export const CHAT_KINDS: ChatKind[] = ['slack', 'discord', 'teams', 'google-chat', 'mattermost']

/** The settings as they are kept: the mail password with them. */
export interface KeptDelivery {
  email?: { host: string; port: number; user: string; password: string; from: string }
  chats: { name: string; kind: ChatKind; url: string }[]
  ntfy: { server: string }
}

export const NO_DELIVERY: KeptDelivery = { chats: [], ntfy: { server: 'https://ntfy.sh' } }

/** What a browser is shown: no password, only whether there is one. */
export function shown(kept: KeptDelivery): DeliverySettings {
  const { email, ...rest } = kept
  return { ...rest, ...(email ? { email: { host: email.host, port: email.port, user: email.user, from: email.from, has_password: email.password !== '' } } : {}) }
}


const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const ADDRESS = /^[^\s@,<>"]+@[^\s@,<>"]+$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/

/** New settings from a browser, the password kept when none is given. */
export function checkDelivery(given: unknown, before: KeptDelivery): KeptDelivery {
  if (typeof given !== 'object' || given === null) throw new Refusal('settings are needed')
  const g = given as Record<string, unknown>
  let email: KeptDelivery['email']
  if (g.email !== undefined && g.email !== null) {
    const e = g.email as Record<string, unknown>
    const host = String(e.host ?? '').trim()
    const port = Number(e.port)
    const user = String(e.user ?? '').trim()
    const from = String(e.from ?? '').trim() || user
    if (!HOST.test(host)) throw new Refusal('the mail server is a host name')
    if (port !== 465 && port !== 587) throw new Refusal('the mail port is 465 (TLS) or 587 (STARTTLS)')
    if (!ADDRESS.test(user) && !/^[A-Za-z0-9._-]{1,100}$/.test(user)) throw new Refusal('the mail login is an address or a user name')
    if (!ADDRESS.test(from)) throw new Refusal('"From" is an e-mail address')
    const typed = typeof e.password === 'string' ? e.password.replace(/\s/g, '') : ''
    const password = typed !== '' ? typed : before.email?.password ?? ''
    if (password === '') throw new Refusal('the mail password is needed (for Gmail, an app password)')
    email = { host, port, user, password, from }
  }
  const chats: KeptDelivery['chats'] = []
  for (const c of Array.isArray(g.chats) ? (g.chats as Record<string, unknown>[]) : []) {
    const name = String(c.name ?? '').trim()
    const kind = String(c.kind ?? '') as ChatKind
    const url = String(c.url ?? '').trim()
    if (!NAME.test(name)) throw new Refusal('a chat link has a short name')
    if (chats.some((k) => k.name === name)) throw new Refusal(`two chat links are called '${name}'`)
    if (!CHAT_KINDS.includes(kind)) throw new Refusal(`${name}: choose what kind of chat it is`)
    if (!/^https:\/\/[^\s]+$/.test(url) || url.length > 1000) throw new Refusal(`${name}: the link is the chat's https:// webhook address`)
    chats.push({ name, kind, url })
  }
  const server = String((g.ntfy as Record<string, unknown> | undefined)?.server ?? '').trim().replace(/\/+$/, '') || 'https://ntfy.sh'
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(server)) throw new Refusal('the ntfy server is an address such as https://ntfy.sh')
  return { ...(email ? { email } : {}), chats, ntfy: { server } }
}

/** A contact's ways, checked against the settings. */
export function checkReach(given: unknown, kept: KeptDelivery): Reach {
  if (given === undefined || given === null) return {}
  if (typeof given !== 'object') throw new Refusal('how to reach them is a list of ways')
  const g = given as Record<string, unknown>
  const out: Reach = {}
  if (g.email === true) out.email = true
  if (typeof g.chat === 'string' && g.chat !== '') {
    if (!kept.chats.some((c) => c.name === g.chat)) throw new Refusal(`there is no chat link '${g.chat}'`)
    out.chat = g.chat
  }
  if (typeof g.ntfy === 'string' && g.ntfy !== '') {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(g.ntfy)) throw new Refusal('an ntfy topic is 16 to 64 letters, digits, - and _')
    out.ntfy = g.ntfy
  }
  return out
}

export const anyWay = (reach: Reach | undefined) => !!reach && (reach.email === true || !!reach.chat || !!reach.ntfy)

/** A topic no one guesses: on a public ntfy server, the topic is the secret. */
export function newTopic(): string {
  return `nuthatch-${randomBytes(15).toString('base64url')}`
}

// --- e-mail ------------------------------------------------------------

/** RFC 2047 for a header that is not plain ASCII. */
function header(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ')
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** The message as sent: headers, and the body in base64 (UTF-8). */
export function mailText(from: string, to: string, subject: string, body: string, date = new Date()): string {
  const domain = from.split('@')[1] ?? 'nuthatch'
  const lines = Buffer.from(body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g) ?? []
  return [
    `From: nuthatch <${from}>`,
    `To: <${to}>`,
    `Subject: ${header(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    ...lines,
  ].join('\r\n')
}

/** A conversation with an SMTP server: one reply at a time. */
class Smtp {
  private socket: Socket | TLSSocket
  private buffer = ''
  private waiting: ((line: string) => void) | null = null
  private failed: Error | null = null

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket
    this.listen()
  }

  private listen() {
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.wake()
    })
    this.socket.on('error', (err) => {
      this.failed = err
      this.wake()
    })
    this.socket.on('close', () => {
      this.failed ??= new Error('the mail server closed the connection')
      this.wake()
    })
  }

  private wake() {
    const w = this.waiting
    if (w) w('')
  }

  /** The next whole reply: its code, and its text. */
  async reply(): Promise<{ code: number; text: string }> {
    for (;;) {
      // A reply ends at a line "NNN text" (not "NNN-text").
      const lines = this.buffer.split('\r\n')
      const end = lines.findIndex((l) => /^\d{3}( |$)/.test(l))
      if (end >= 0) {
        const taken = lines.slice(0, end + 1)
        this.buffer = lines.slice(end + 1).join('\r\n')
        return { code: Number(taken[end]?.slice(0, 3)), text: taken.map((l) => l.slice(4)).join('\n') }
      }
      if (this.failed) throw this.failed
      await new Promise<void>((resolve) => (this.waiting = () => resolve()))
      this.waiting = null
    }
  }

  async say(line: string, want: number[], what: string): Promise<string> {
    this.socket.write(`${line}\r\n`)
    return this.expect(want, what)
  }

  async expect(want: number[], what: string): Promise<string> {
    const { code, text } = await this.reply()
    if (!want.includes(code)) throw new Refusal(`the mail server refused ${what}: ${code} ${text.split('\n')[0] ?? ''}`.trim())
    return text
  }

  /** Over to TLS on the same connection (STARTTLS). */
  async secure(host: string, ca?: string): Promise<void> {
    this.socket.removeAllListeners('data')
    this.socket.removeAllListeners('error')
    this.socket.removeAllListeners('close')
    const plain = this.socket
    this.socket = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ socket: plain, servername: host, ...(ca ? { ca } : {}) }, () => resolve(s))
      s.once('error', reject)
    })
    this.buffer = ''
    this.listen()
  }

  close() {
    this.socket.destroy()
  }
}

/** Sends one mail; the reason when the server or the network will not. */
export async function sendMail(
  settings: NonNullable<KeptDelivery['email']>,
  to: string,
  subject: string,
  body: string,
  { timeout = 20_000, ca, at }: { timeout?: number; ca?: string; at?: number } = {},
): Promise<void> {
  if (!ADDRESS.test(to)) throw new Refusal(`'${to}' is not an e-mail address`)
  const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
    const s =
      settings.port === 465
        ? tlsConnect({ host: settings.host, port: at ?? 465, servername: settings.host, ...(ca ? { ca } : {}) }, () => resolve(s))
        : tcpConnect({ host: settings.host, port: at ?? settings.port }, () => resolve(s))
    s.setTimeout(timeout, () => s.destroy(new Error(`the mail server ${settings.host} did not answer in time`)))
    s.once('error', reject)
  })
  const smtp = new Smtp(socket)
  try {
    await smtp.expect([220], 'the connection')
    const me = 'nuthatch.invalid'
    let features = await smtp.say(`EHLO ${me}`, [250], 'EHLO')
    if (settings.port === 587) {
      if (!/^STARTTLS$/im.test(features)) throw new Refusal('the mail server does not offer STARTTLS on port 587')
      await smtp.say('STARTTLS', [220], 'STARTTLS')
      await smtp.secure(settings.host, ca)
      features = await smtp.say(`EHLO ${me}`, [250], 'EHLO')
    }
    if (!/^AUTH\b.*\bPLAIN\b/im.test(features)) throw new Refusal('the mail server does not offer a password login (AUTH PLAIN)')
    const plain = Buffer.from(`\0${settings.user}\0${settings.password}`, 'utf8').toString('base64')
    await smtp.say(`AUTH PLAIN ${plain}`, [235], 'the login (for Gmail, use an app password)')
    await smtp.say(`MAIL FROM:<${settings.from}>`, [250], 'the sender')
    await smtp.say(`RCPT TO:<${to}>`, [250, 251], `the address ${to}`)
    await smtp.say('DATA', [354], 'DATA')
    // A line that starts with a dot gets another (RFC 5321 4.5.2).
    const text = mailText(settings.from, to, subject, body).replace(/^\./gm, '..')
    await smtp.say(`${text}\r\n.`, [250], 'the message')
    await smtp.say('QUIT', [221], 'QUIT').catch(() => undefined)
  } finally {
    smtp.close()
  }
}

// --- chat and ntfy -----------------------------------------------------

/** The body a chat's incoming webhook takes. */
export function chatBody(kind: ChatKind, title: string, body: string, link?: string): unknown {
  const text = [title, body, link].filter(Boolean).join('\n')
  switch (kind) {
    case 'slack':
    case 'mattermost':
      return { text: [`*${title}*`, body, link ? `<${link}|Open>` : ''].filter(Boolean).join('\n') }
    case 'discord':
      return { content: [`**${title}**`, body, link].filter(Boolean).join('\n').slice(0, 2000) }
    case 'google-chat':
      return { text: [`*${title}*`, body, link].filter(Boolean).join('\n') }
    case 'teams':
      // Teams' Workflows webhook: an Adaptive Card.
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
                ...(body ? [{ type: 'TextBlock', text: body, wrap: true }] : []),
              ],
              ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open', url: link }] } : {}),
            },
          },
        ],
      }
    default:
      return { text }
  }
}

async function post(url: string, init: RequestInit, what: string, fetcher: typeof fetch): Promise<void> {
  let answer: Response
  try {
    answer = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' })
  } catch (err) {
    throw new Refusal(`${what}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!answer.ok) throw new Refusal(`${what} answered ${answer.status}`)
}

export function sendChat(url: string, kind: ChatKind, title: string, body: string, link: string | undefined, fetcher: typeof fetch = fetch): Promise<void> {
  return post(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chatBody(kind, title, body, link)) }, 'the chat', fetcher)
}

export function sendNtfy(server: string, topic: string, title: string, body: string, urgent: boolean, link: string | undefined, fetcher: typeof fetch = fetch): Promise<void> {
  // JSON to the server's root: the title may be any text, unlike a header.
  const message = { topic, title, message: body || title, priority: urgent ? 4 : 3, tags: [urgent ? 'warning' : 'white_check_mark'], ...(link ? { click: link } : {}) }
  return post(server, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }, 'ntfy', fetcher)
}

/** Where a message leads, as a full address, when nuthatch knows its own. */
export const linkOf = (base: string | undefined, message: Message) => (base ? `${base.replace(/\/+$/, '')}/${message.url}` : undefined)

/** One message to one contact, every way they have; what failed, by way. */
export async function deliver(
  kept: KeptDelivery,
  reach: Reach,
  email: string | undefined,
  message: Message,
  urgent: boolean,
  base: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const link = linkOf(base, message)
  const failed: string[] = []
  const tries: Promise<void>[] = []
  const attempt = (way: string, run: () => Promise<void>) => tries.push(run().catch((err: unknown) => void failed.push(`${way}: ${err instanceof Error ? err.message : String(err)}`)))
  if (reach.email && kept.email && email) {
    const settings = kept.email
    attempt('e-mail', () => sendMail(settings, email, message.title, [message.body, link].filter(Boolean).join('\n\n')))
  }
  const chat = reach.chat ? kept.chats.find((c) => c.name === reach.chat) : undefined
  if (chat) attempt(`chat ${chat.name}`, () => sendChat(chat.url, chat.kind, message.title, message.body, link, fetcher))
  if (reach.ntfy) {
    const topic = reach.ntfy
    attempt('ntfy', () => sendNtfy(kept.ntfy.server, topic, message.title, message.body, urgent, link, fetcher))
  }
  await Promise.all(tries)
  return failed
}
