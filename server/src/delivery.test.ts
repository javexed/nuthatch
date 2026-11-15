import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket, createServer as createTlsServer } from 'node:tls'
import { describe, expect, it } from 'vitest'
import type { Backend } from './backend.ts'
import { NO_DELIVERY, chatBody, checkDelivery, checkReach, mailText, newTopic, sendMail, shown } from './delivery.ts'
import { Pusher } from './push.ts'
import { Store } from './store.ts'

const certs = mkdtempSync(join(tmpdir(), 'nuthatch-smtp-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(certs, 'key.pem'), '-out', join(certs, 'cert.pem')], { stdio: 'ignore' })
const cert = readFileSync(join(certs, 'cert.pem'), 'utf8')
const key = readFileSync(join(certs, 'key.pem'), 'utf8')

/** A mail server that takes one message: what it was told, line by line. */
function smtpServer(mode: 'tls' | 'starttls', password = 'app-pass') {
  const said: string[] = []
  let data = ''
  const talk = (socket: Socket | TLSSocket, secure: boolean) => {
    let buffer = ''
    let inData = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          data = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          socket.write('250 queued\r\n')
          continue
        }
        const at = buffer.indexOf('\r\n')
        if (at < 0) return
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        said.push(line)
        const verb = line.split(' ')[0]?.toUpperCase()
        if (verb === 'EHLO') socket.write(secure ? '250-localhost\r\n250 AUTH PLAIN LOGIN\r\n' : '250-localhost\r\n250 STARTTLS\r\n')
        else if (verb === 'STARTTLS') {
          socket.write('220 go ahead\r\n')
          socket.removeAllListeners('data')
          const upgraded = new TLSSocket(socket, { isServer: true, cert, key })
          talk(upgraded, true)
          return
        } else if (verb === 'AUTH') {
          const plain = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8')
          socket.write(plain === `\0me@example.test\0${password}` ? '235 ok\r\n' : '535 5.7.8 Username and Password not accepted\r\n')
        } else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 ok\r\n')
        else if (verb === 'DATA') {
          inData = true
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        }
      }
    })
  }
  const server =
    mode === 'tls'
      ? createTlsServer({ cert, key }, (s) => {
          s.write('220 localhost ESMTP\r\n')
          talk(s, true)
        })
      : createServer((s) => {
          s.write('220 localhost ESMTP\r\n')
          talk(s, false)
        })
  return { server, said, data: () => data }
}

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

describe('e-mail', () => {
  const settings = { host: 'localhost', port: 465, user: 'me@example.test', password: 'app-pass', from: 'me@example.test' }

  it('is sent over TLS (465), logged in with the app password', async () => {
    const fake = smtpServer('tls')
    const at = await listen(fake.server)
    try {
      await sendMail(settings, 'ops@example.test', 'web1 / HTTP is CRITICAL ✗', 'Connection refused\n.dot line', { ca: cert, at })
      expect(fake.said).toContain('MAIL FROM:<me@example.test>')
      expect(fake.said).toContain('RCPT TO:<ops@example.test>')
      const text = fake.data()
      expect(text).toContain('Subject: =?UTF-8?B?')
      const body = Buffer.from(text.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '', 'base64').toString('utf8')
      expect(body).toBe('Connection refused\r\n.dot line')
    } finally {
      fake.server.close()
    }
  })

  it('is sent over STARTTLS (587), and a wrong password says so', async () => {
    const fake = smtpServer('starttls')
    const at = await listen(fake.server)
    try {
      await sendMail({ ...settings, port: 587 }, 'ops@example.test', 'test', 'body', { ca: cert, at })
      expect(fake.said.filter((l) => l.startsWith('EHLO'))).toHaveLength(2)
      await expect(sendMail({ ...settings, port: 587, password: 'wrong' }, 'ops@example.test', 'test', 'body', { ca: cert, at })).rejects.toThrow(/login.*535/)
    } finally {
      fake.server.close()
    }
  })

  it('does not trust a server it cannot verify', async () => {
    const fake = smtpServer('tls')
    const at = await listen(fake.server)
    try {
      await expect(sendMail(settings, 'ops@example.test', 'test', 'body', { at })).rejects.toThrow()
    } finally {
      fake.server.close()
    }
  })

  it('writes plain ASCII headers as they are', () => {
    const text = mailText('me@example.test', 'ops@example.test', 'web1 is DOWN', 'x', new Date(0))
    expect(text).toContain('Subject: web1 is DOWN\r\n')
    expect(text).toContain('Date: Thu, 01 Jan 1970 00:00:00 +0000')
  })
})

describe('delivery settings', () => {
  it('keep the password when none is typed, and never show it', () => {
    const first = checkDelivery({ email: { host: 'smtp.gmail.com', port: 465, user: 'me@example.test', password: 'abcd efgh ijkl mnop' }, chats: [], ntfy: {} }, NO_DELIVERY)
    expect(first.email?.password).toBe('abcdefghijklmnop')
    expect(first.email?.from).toBe('me@example.test')
    const again = checkDelivery({ email: { host: 'smtp.gmail.com', port: 465, user: 'me@example.test', password: '' }, chats: [], ntfy: {} }, first)
    expect(again.email?.password).toBe('abcdefghijklmnop')
    expect(JSON.stringify(shown(again))).not.toContain('abcdefgh')
    expect(shown(again).email?.has_password).toBe(true)
    expect(again.ntfy.server).toBe('https://ntfy.sh')
  })

  it('refuse what cannot be sent to', () => {
    expect(() => checkDelivery({ email: { host: 'smtp.gmail.com', port: 25, user: 'me@example.test', password: 'x' }, chats: [] }, NO_DELIVERY)).toThrow(/465/)
    expect(() => checkDelivery({ email: { host: 'smtp.gmail.com', port: 465, user: 'me@example.test' }, chats: [] }, NO_DELIVERY)).toThrow(/app password/)
    expect(() => checkDelivery({ chats: [{ name: 'ops', kind: 'slack', url: 'http://hooks.example.test/x' }] }, NO_DELIVERY)).toThrow(/https/)
    expect(() => checkDelivery({ chats: [{ name: 'ops', kind: 'irc', url: 'https://hooks.example.test/x' }] }, NO_DELIVERY)).toThrow(/kind/)
    expect(() => checkDelivery({ chats: [], ntfy: { server: 'ftp://x' } }, NO_DELIVERY)).toThrow(/ntfy/)
  })

  it("check a contact's ways against them", () => {
    const kept = checkDelivery({ chats: [{ name: 'ops', kind: 'discord', url: 'https://hooks.example.test/x' }] }, NO_DELIVERY)
    const topic = newTopic()
    expect(topic).toMatch(/^nuthatch-[A-Za-z0-9_-]{20}$/)
    expect(checkReach({ email: true, chat: 'ops', ntfy: topic }, kept)).toEqual({ email: true, chat: 'ops', ntfy: topic })
    expect(() => checkReach({ chat: 'dev' }, kept)).toThrow(/no chat link/)
    expect(() => checkReach({ ntfy: 'short' }, kept)).toThrow(/topic/)
    expect(checkReach(undefined, kept)).toEqual({})
  })
})

describe('chat', () => {
  it("is in each chat's own shape", () => {
    expect(chatBody('slack', 'web1 is DOWN', 'timeout', 'https://n.example.test/host/a/web1')).toEqual({ text: '*web1 is DOWN*\ntimeout\n<https://n.example.test/host/a/web1|Open>' })
    expect(chatBody('discord', 'web1 is DOWN', 'timeout')).toEqual({ content: '**web1 is DOWN**\ntimeout' })
    expect(chatBody('google-chat', 'web1 is DOWN', '')).toEqual({ text: '*web1 is DOWN*' })
    const teams = chatBody('teams', 'web1 is DOWN', 'timeout', 'https://n.example.test/') as { attachments: { content: { body: unknown[]; actions: unknown[] } }[] }
    expect(teams.attachments[0]?.content.body).toHaveLength(2)
    expect(teams.attachments[0]?.content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open', url: 'https://n.example.test/' }])
  })
})

describe('a notification the engine logged', () => {
  it('reaches a contact by chat and ntfy, as well as their browsers', async () => {
    const store = new Store(':memory:')
    const posts: { url: string; body: unknown }[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const backend: Backend = {
      name: 'site',
      query: async (request: string) =>
        request.startsWith('GET log') ? [[1700000000, '[1700000000] SERVICE NOTIFICATION: ops;web1;HTTP;CRITICAL;nuthatch_notify;Connection refused']] : [],
    } as unknown as Backend
    const pusher = new Pusher(store, 'https://nuthatch.example.test', [backend], 0, fetcher)
    pusher.setDelivery(checkDelivery({ chats: [{ name: 'ops', kind: 'slack', url: 'https://hooks.example.test/x' }], ntfy: { server: 'https://ntfy.example.test' } }, NO_DELIVERY))
    store.setReach('site', 'ops', JSON.stringify({ chat: 'ops', ntfy: 'nuthatch-abcdefghijklmnopqrst' }))
    expect(store.anyReach()).toBe(true)
    expect(await pusher.toContact(backend, 'ops', { title: 'web1 / HTTP is CRITICAL', body: 'Connection refused', url: 'service/site/web1/HTTP', tag: 't' }, true)).toEqual([])
    expect(posts.map((p) => p.url).sort()).toEqual(['https://hooks.example.test/x', 'https://ntfy.example.test'])
    const ntfy = posts.find((p) => p.url === 'https://ntfy.example.test')?.body as Record<string, unknown>
    expect(ntfy).toMatchObject({ topic: 'nuthatch-abcdefghijklmnopqrst', title: 'web1 / HTTP is CRITICAL', priority: 4, click: 'https://nuthatch.example.test/service/site/web1/HTTP' })
    // E-mail without an address is said, not sent.
    store.setReach('site', 'ops', JSON.stringify({ email: true }))
    expect(await pusher.toContact(backend, 'ops', { title: 't', body: '', url: '', tag: 't' }, false)).toEqual(['e-mail: the contact has no e-mail address'])
    // And the pass itself sends it on.
    posts.length = 0
    store.setReach('site', 'ops', JSON.stringify({ chat: 'ops' }))
    await pusher.pass(backend, 1700000000, new Set())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(posts).toHaveLength(1)
  })
})
