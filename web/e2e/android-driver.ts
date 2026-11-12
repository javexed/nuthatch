// Drives the app inside an Android emulator, through the debugging port of
// its web view (mobile/test-emulator forwards it to 127.0.0.1:9223): logs
// in at the server for a token and acknowledges a problem. It speaks the
// DevTools protocol itself; the steps run in the app's own page.
import { writeFileSync } from 'node:fs'
import { livestatus } from './helpers.ts'

const password = process.env.NUTHATCH_TEST_PASSWORD ?? ''
const queue = 'GET services\nColumns: acknowledged\nFilter: host_name = mail1\nFilter: description = queue'
const step = (text: string) => console.log(`ok    ${text}`)

const pages = (await (await fetch('http://127.0.0.1:9223/json')).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
const target = pages.find((p) => p.type === 'page')
if (!target) throw new Error('the app shows no page')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = () => reject(new Error('the web view cannot be reached'))
})
let last = 0
const waiting = new Map<number, (message: { result?: Record<string, unknown>; error?: { message: string } }) => void>()
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } }
  if (message.id !== undefined) waiting.get(message.id)?.(message)
}
function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++last
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result ?? {})))
  })
}

/** What the steps in the page are written with. */
const HELPERS = `
  const until = async (find, what) => {
    const end = Date.now() + 20000
    for (;;) {
      const found = find()
      if (found) return found
      if (Date.now() > end) throw new Error('waited in vain for ' + what)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  const field = (label, root = document) => until(() => [...root.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(label))?.querySelector('input, textarea'), 'the field ' + label)
  const type = async (label, text, root = document) => {
    const el = await field(label, root)
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = async (name, root = document) => (await until(() => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === name), 'the button ' + name)).click()
  const text = (selector) => document.querySelector(selector)?.textContent ?? ''
`

/** Runs steps in the app's page and gives what they return. */
async function inPage<T>(body: string): Promise<T> {
  const result = await call('Runtime.evaluate', { expression: `(async () => { ${HELPERS} ${body} })()`, awaitPromise: true, returnByValue: true })
  const thrown = result.exceptionDetails as { exception?: { description?: string } } | undefined
  if (thrown) throw new Error(thrown.exception?.description ?? 'a step failed in the page')
  return (result.result as { value: T }).value
}

try {
  const about = await inPage<string>('return location.origin + " · " + navigator.userAgent')
  console.log(`      the app's page: ${about}`)
  if (!about.includes('Android')) throw new Error('this is not the app in Android')

  await inPage(`
    await type('Server', 'http://localhost:8092')
    await type('User', 'admin')
    await type('Password', ${JSON.stringify(password)})
    await press('Log in')
    await until(() => text('h1') === 'Overview', 'the overview: ' + text('[role=alert]'))
  `)
  const token = await inPage<string>("return JSON.parse(localStorage.getItem('nuthatch.app') ?? '{}').token ?? ''")
  if (!token.startsWith('nh_')) throw new Error('the app keeps no token')
  step('the app logged in at the server for a token')
  const hosts = await inPage<string>("return await until(() => { const n = text('section[aria-label=Hosts] .tile strong'); return n !== '' && n !== '0' ? n : null }, 'the hosts')")
  step(`the overview shows the hosts (${hosts} up)`)

  await inPage(`
    location.hash = '#/service/naemon/mail1/queue'
    await until(() => text('h1').startsWith('queue') && text('.headline .badge') !== '', 'the service')
    if (text('.headline').includes('acknowledged')) {
      await press('Remove acknowledgement')
      await until(() => !text('.headline').includes('acknowledged'), 'the old acknowledgement to go')
    }
    await press('Acknowledge')
    const dialog = await until(() => document.querySelector('dialog[open]'), 'the dialog')
    await type('Comment', 'from the phone', dialog)
    await press('Acknowledge', dialog)
    await until(() => text('.headline').includes('acknowledged'), 'the acknowledgement: ' + text('dialog .failed'))
  `)
  const acknowledged = (await livestatus('naemon', queue))[0]?.[0]
  if (acknowledged !== 1) throw new Error(`the engine does not have the acknowledgement: ${String(acknowledged)}`)
  step('the problem is acknowledged, and the engine says so')
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  if (typeof shot.data === 'string') writeFileSync(process.env.SHOT ?? 'android.png', Buffer.from(shot.data, 'base64'))

  await inPage(`
    await press('Remove acknowledgement')
    await until(() => !text('.headline').includes('acknowledged'), 'the acknowledgement to go')
    await press('Log out')
    await field('Server')
    if (localStorage.getItem('nuthatch.app') !== null) throw new Error('the token is still on the device')
  `)
  const after = await fetch('http://127.0.0.1:8092/api/v1/session', { headers: { Authorization: `Bearer ${token}` } })
  if (after.status !== 401) throw new Error(`the token still works: ${after.status}`)
  step('logged out; the token is gone from the device and from the server')
} finally {
  socket.close()
}
