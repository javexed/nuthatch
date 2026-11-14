// Looking at a machine before it is added: what its name is, whether it
// answers ping, which of some well-known TCP ports are open and what
// answers there, and from that, which checks to suggest.
//
// Only the one address asked about is touched, a few ports at a time with
// short timeouts, and nothing is followed elsewhere (no redirects). It runs
// where the engine runs, so that what it finds is what the engine can
// reach. For users with the role config_edit only.

import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { type Socket, connect as tcpConnect, isIP } from 'node:net'
import { type PeerCertificate, type TLSSocket, connect as tlsConnect } from 'node:tls'
import type { Discovery, FoundPort, Suggestion } from '@nuthatch/api'
import { Refused } from './policy.ts'

type Kind = 'banner' | 'web' | 'tls' | 'open'

interface Known {
  port: number
  service: string
  kind: Kind
}

/** The ports looked at, with what usually answers there. */
export const PORTS: Known[] = [
  { port: 21, service: 'FTP', kind: 'banner' },
  { port: 22, service: 'SSH', kind: 'banner' },
  { port: 23, service: 'Telnet', kind: 'open' },
  { port: 25, service: 'SMTP', kind: 'banner' },
  { port: 53, service: 'DNS', kind: 'open' },
  { port: 80, service: 'HTTP', kind: 'web' },
  { port: 110, service: 'POP3', kind: 'banner' },
  { port: 139, service: 'NetBIOS', kind: 'open' },
  { port: 143, service: 'IMAP', kind: 'banner' },
  { port: 389, service: 'LDAP', kind: 'open' },
  { port: 443, service: 'HTTPS', kind: 'web' },
  { port: 445, service: 'SMB', kind: 'open' },
  { port: 465, service: 'SMTPS', kind: 'tls' },
  { port: 587, service: 'Submission', kind: 'banner' },
  { port: 636, service: 'LDAPS', kind: 'tls' },
  { port: 993, service: 'IMAPS', kind: 'tls' },
  { port: 995, service: 'POP3S', kind: 'tls' },
  { port: 1883, service: 'MQTT', kind: 'open' },
  { port: 2049, service: 'NFS', kind: 'open' },
  { port: 2222, service: 'SSH 2222', kind: 'banner' },
  { port: 2283, service: 'Immich', kind: 'web' },
  { port: 3000, service: 'Web 3000', kind: 'web' },
  { port: 3306, service: 'MySQL', kind: 'open' },
  { port: 3389, service: 'RDP', kind: 'open' },
  { port: 5000, service: 'Web 5000', kind: 'web' },
  { port: 5001, service: 'Web 5001', kind: 'web' },
  { port: 5432, service: 'PostgreSQL', kind: 'open' },
  { port: 5900, service: 'VNC', kind: 'banner' },
  { port: 6379, service: 'Redis', kind: 'open' },
  { port: 8000, service: 'Web 8000', kind: 'web' },
  { port: 8006, service: 'Proxmox', kind: 'web' },
  { port: 8080, service: 'Web 8080', kind: 'web' },
  { port: 8096, service: 'Jellyfin', kind: 'web' },
  { port: 8123, service: 'Home Assistant', kind: 'web' },
  { port: 8443, service: 'Web 8443', kind: 'web' },
  { port: 8883, service: 'MQTTS', kind: 'tls' },
  { port: 9090, service: 'Web 9090', kind: 'web' },
  { port: 9100, service: 'Node exporter', kind: 'web' },
  { port: 27017, service: 'MongoDB', kind: 'open' },
  { port: 32400, service: 'Plex', kind: 'web' },
]

const CONNECT_MS = 1500
const PROBE_MS = 3000
const AT_ONCE = 10

export interface Target {
  /** What is looked up and connected to: a name or an IP address. */
  host: string
  /** For a URL: its scheme, port and path. */
  url?: { https: boolean; port: number; path: string }
}

const HOST = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*\.?$/

/** What was typed: a name, an IP address, or an http(s) URL. */
export function parseTarget(given: unknown): Target {
  if (typeof given !== 'string') throw new Refused('give a name, an address or a URL')
  const text = given.trim()
  if (text === '' || text.length > 300) throw new Refused('give a name, an address or a URL')
  if (/^https?:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new Refused(`'${text}' is not a URL`)
    }
    if (url.username || url.password) throw new Refused('a URL with a user or password in it is not looked at')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!HOST.test(host) && isIP(host) === 0) throw new Refused(`'${host}' is not a host name or address`)
    const https = url.protocol === 'https:'
    const path = url.pathname + url.search
    // Kept to what a check command can carry.
    if (!/^\/[A-Za-z0-9._~\/?=&%+-]*$/.test(path) || path.length > 200) throw new Refused("the URL's path has letters a check cannot carry")
    return { host, url: { https, port: Number(url.port || (https ? 443 : 80)), path } }
  }
  const host = text.replace(/^\[|\]$/g, '')
  if (!HOST.test(host) && isIP(host) === 0) throw new Refused(`'${text}' is not a host name, address or URL`)
  return { host }
}

/** A name for the host from what was typed: its first label, or the address. */
export function hostName(host: string): string {
  if (isIP(host) !== 0) return host.replace(/[:]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  const first = host.replace(/\.$/, '').split('.')[0] ?? host
  return first.slice(0, 63)
}

function connected(address: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = tcpConnect({ host: address, port, timeout: CONNECT_MS })
    const end = (open: boolean) => {
      socket.destroy()
      done(open)
    }
    socket.once('connect', () => end(true))
    socket.once('timeout', () => end(false))
    socket.once('error', () => end(false))
  })
}

/** The first line a service says on its own, as SSH, SMTP and IMAP do. */
function banner(address: string, port: number): Promise<string | undefined> {
  return new Promise((done) => {
    const socket: Socket = tcpConnect({ host: address, port, timeout: PROBE_MS })
    let got = ''
    const end = () => {
      socket.destroy()
      const line = got.split(/\r?\n/)[0]?.trim()
      // Only what prints: a banner is shown, and a binary greeting is not one.
      done(line && /^[\x20-\x7e]+$/.test(line) ? line.slice(0, 120) : undefined)
    }
    socket.on('data', (chunk: Buffer) => {
      got += chunk.toString('latin1')
      if (got.includes('\n') || got.length > 512) end()
    })
    socket.once('timeout', end)
    socket.once('error', end)
    socket.once('end', end)
  })
}

interface TlsSeen {
  subject?: string
  issuer?: string
  expires: string
  days: number
  trusted: boolean
}

/** The certificate a TLS port shows, or nothing when it speaks no TLS. */
function certificate(address: string, port: number, serverName: string | undefined): Promise<TlsSeen | undefined> {
  return new Promise((done) => {
    let socket: TLSSocket
    try {
      socket = tlsConnect({ host: address, port, servername: serverName, rejectUnauthorized: false, timeout: PROBE_MS })
    } catch {
      done(undefined)
      return
    }
    const end = (seen?: TlsSeen) => {
      socket.destroy()
      done(seen)
    }
    socket.once('secureConnect', () => {
      const cert: PeerCertificate = socket.getPeerCertificate()
      if (!cert || !cert.valid_to) return end(undefined)
      const expires = new Date(cert.valid_to)
      const name = (field: unknown) => (typeof field === 'string' ? field : Array.isArray(field) ? String(field[0]) : undefined)
      end({
        subject: name(cert.subject?.CN),
        issuer: name(cert.issuer?.O) ?? name(cert.issuer?.CN),
        expires: expires.toISOString(),
        days: Math.floor((expires.getTime() - Date.now()) / 86_400_000),
        trusted: socket.authorized,
      })
    })
    socket.once('timeout', () => end(undefined))
    socket.once('error', () => end(undefined))
  })
}

interface HttpSeen {
  status: number
  title?: string
  location?: string
}

/** One GET, nothing followed: the status, the page's title, where it sends you. */
function page(address: string, port: number, secure: boolean, hostHeader: string, path: string): Promise<HttpSeen | undefined> {
  return new Promise((done) => {
    const get = secure ? https.get : http.get
    let finished = false
    const end = (seen?: HttpSeen) => {
      if (finished) return
      finished = true
      done(seen)
    }
    const request = get(
      {
        host: address,
        port,
        path,
        timeout: PROBE_MS,
        headers: { Host: hostHeader, 'User-Agent': 'nuthatch (looking before adding a host)' },
        servername: secure && isIP(hostHeader) === 0 ? hostHeader : undefined,
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 65536) response.destroy()
        })
        const finish = () => {
          const title = body.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim()
          const location = response.headers.location
          end({ status: response.statusCode ?? 0, title: title || undefined, location: typeof location === 'string' ? location.slice(0, 200) : undefined })
        }
        response.on('end', finish)
        response.on('close', finish)
        response.on('error', finish)
      },
    )
    request.on('timeout', () => {
      request.destroy()
      end(undefined)
    })
    request.on('error', () => end(undefined))
  })
}

/** One ping, by the system's ping: whether it answered, and how fast. */
function ping(address: string): Promise<{ ok: boolean; ms?: number } | null> {
  return new Promise((done) => {
    execFile('ping', ['-n', '-c', '1', '-W', '2', address], { timeout: 5000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return done(null)
      const ms = stdout.match(/time[=<]([\d.]+) ?ms/)?.[1]
      done({ ok: err === null, ms: ms === undefined ? undefined : Math.round(Number(ms)) })
    })
  })
}

async function inTurn<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        out[at] = await work(items[at] as T)
      }
    }),
  )
  return out
}

/** Where a redirect leads, when it is to https on the same host. */
function toHttps(location: string | undefined, host: string): boolean {
  if (!location) return false
  try {
    const url = new URL(location, `http://${host}/`)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** A service's name as a description may be. */
function describe(text: string): string {
  return (
    text
      .replace(/[^A-Za-z0-9 _.:/+-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 63) || 'Service'
  )
}

/** The checks suggested for what was found. */
export function suggest(target: Target, found: FoundPort[], pinged: boolean | null): { host_check?: string; suggestions: Suggestion[] } {
  const out: Suggestion[] = []
  const add = (s: Suggestion) => {
    let description = describe(s.description)
    for (let n = 2; out.some((o) => o.description === description); n++) description = describe(`${s.description} ${n}`)
    out.push({ ...s, description })
  }
  if (target.url) {
    const { https: secure, port, path } = target.url
    add({
      description: `${secure ? 'HTTPS' : 'HTTP'} ${path === '/' ? '' : path}`.trim(),
      check_command: `${secure ? 'nuthatch_https' : 'nuthatch_http'}!${port}!${path}`,
      checked: true,
      why: 'the address given',
    })
    if (secure) add({ description: 'Certificate', check_command: `nuthatch_cert!${port}`, checked: true, why: 'warns 21 days before it expires' })
  }
  for (const f of found) {
    if (target.url && f.port === target.url.port) continue
    if (f.kind === 'web') {
      const secure = f.tls !== undefined
      const redirectsToHttps = !secure && f.http !== undefined && f.http.status >= 300 && f.http.status < 400 && toHttps(f.http.location, target.host)
      // A port with no name of its own is named by its page: "Grafana"
      // from "Grafana: the dashboards"
      const titled = f.http?.title?.split(/\s[|:·–—-]\s|:\s/)[0]?.trim()
      const name =
        f.service === 'HTTP' || f.service === 'HTTPS'
          ? secure ? 'HTTPS' : 'HTTP'
          : f.service.startsWith('Web ') && titled && titled.length <= 30 ? titled : f.service
      add({
        description: name,
        check_command: `${secure ? 'nuthatch_https' : 'nuthatch_http'}!${f.port}!/`,
        checked: !redirectsToHttps && (f.http === undefined || f.http.status < 500),
        why: f.http ? `HTTP ${f.http.status}${f.http.title ? ` "${f.http.title}"` : ''}${redirectsToHttps ? ', sends you to https' : ''}` : 'answers',
      })
      if (secure && f.tls) {
        add({
          description: f.port === 443 ? 'Certificate' : `Certificate ${f.port}`,
          check_command: `nuthatch_cert!${f.port}`,
          checked: f.tls.trusted,
          why: f.tls.trusted ? `expires in ${f.tls.days} days` : `not trusted here (${f.tls.issuer ?? 'unknown issuer'}), expires in ${f.tls.days} days`,
        })
      }
    } else if (f.service.startsWith('SSH')) {
      add({ description: f.service, check_command: `nuthatch_ssh!${f.port}`, checked: true, why: f.banner ?? `port ${f.port}` })
    } else if (f.service === 'SMTP' || f.service === 'Submission') {
      add({ description: f.service, check_command: `nuthatch_smtp!${f.port}`, checked: true, why: f.banner ?? `port ${f.port}` })
    } else if (f.service === 'IMAP') {
      add({ description: 'IMAP', check_command: `nuthatch_imap!${f.port}`, checked: true, why: f.banner ?? `port ${f.port}` })
    } else if (f.service === 'IMAPS') {
      add({ description: 'IMAPS', check_command: `nuthatch_imaps!${f.port}`, checked: true, why: f.tls ? `TLS, expires in ${f.tls.days} days` : `port ${f.port}` })
    } else {
      // Telnet and NetBIOS are found, but not worth watching by default.
      add({ description: f.service, check_command: `nuthatch_tcp!${f.port}`, checked: !['Telnet', 'NetBIOS'].includes(f.service), why: f.banner ?? `port ${f.port} open` })
    }
  }
  // A host that does not answer ping is checked on its first open port.
  const first = found[0]
  const hostCheck = pinged === false && first !== undefined ? `nuthatch_tcp!${first.port}` : undefined
  return { host_check: hostCheck, suggestions: out }
}

/** Looks at what was typed, and suggests a host and its checks. */
/** `also`: further ports to try, those a host's checks are of, so that one that is checked is not taken for gone. */
export async function discover(given: unknown, also: unknown = []): Promise<Discovery> {
  const target = parseTarget(given)
  let addresses: string[]
  try {
    addresses = isIP(target.host) !== 0 ? [target.host] : (await lookup(target.host, { all: true })).map((a) => a.address)
  } catch {
    throw new Refused(`'${target.host}' cannot be found: no such name here`)
  }
  // IPv4 first: the plugins and most services reach it more surely.
  const address = addresses.find((a) => isIP(a) === 4) ?? addresses[0]
  if (address === undefined) throw new Refused(`'${target.host}' has no address`)

  const ports = [...PORTS]
  if (target.url && !ports.some((p) => p.port === target.url?.port)) ports.push({ port: target.url.port, service: `Web ${target.url.port}`, kind: 'web' })
  if (!Array.isArray(also) || also.length > 30 || also.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Refused('the further ports are up to 30 port numbers')
  for (const port of also as number[]) if (!ports.some((p) => p.port === port)) ports.push({ port, service: `Port ${port}`, kind: 'open' })
  const [pinged, open] = await Promise.all([ping(address), inTurn(ports, async (p) => ((await connected(address, p.port)) ? p : null))])
  const serverName = isIP(target.host) === 0 ? target.host : undefined
  const found: FoundPort[] = await inTurn(
    open.filter((p): p is Known => p !== null),
    async (p): Promise<FoundPort> => {
      const seen: FoundPort = { port: p.port, service: p.service, kind: p.kind }
      if (p.kind === 'banner') seen.banner = await banner(address, p.port)
      if (p.kind === 'tls' || p.kind === 'web') seen.tls = await certificate(address, p.port, serverName)
      if (p.kind === 'web') {
        const path = target.url && target.url.port === p.port ? target.url.path : '/'
        seen.http = await page(address, p.port, seen.tls !== undefined, target.host, path)
      }
      return seen
    },
  )
  const { host_check, suggestions } = suggest(target, found, pinged === null ? null : pinged.ok)
  return {
    input: String(given).trim(),
    name: hostName(target.host),
    address: target.host,
    addresses,
    ping: pinged,
    found,
    host_check,
    suggestions,
  }
}

/** A machine of the tailnet this server is on. */
export interface TailnetMachine {
  /** Its short name. */
  name: string
  /** Its full name on the tailnet, to check it by. */
  address: string
  os: string
  online: boolean
  /** Someone else's, shared with this tailnet. */
  shared: boolean
}

/** Reads what `tailscale status --json` says: the other machines, one's own and online ones first. */
export function tailnetMachines(status: unknown): TailnetMachine[] {
  const peers = Object.values(((status as { Peer?: Record<string, unknown> } | null)?.Peer ?? {}) as Record<string, Record<string, unknown>>)
  const out: TailnetMachine[] = []
  for (const peer of peers) {
    const address = String(peer.DNSName ?? '').replace(/\.$/, '').toLowerCase()
    // What cannot be an address of a host is left out, whatever it is.
    if (!HOST.test(address)) continue
    out.push({ name: hostName(address), address, os: String(peer.OS ?? '').slice(0, 20), online: peer.Online === true, shared: peer.ShareeNode === true })
  }
  const rank = (m: TailnetMachine) => (m.shared ? 2 : 0) + (m.online ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address))
}

/** The tailnet's machines as the local tailscale knows them; null where there is none. */
export function askTailscale(): Promise<TailnetMachine[] | null> {
  return new Promise((done) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return done(null)
      try {
        done(tailnetMachines(JSON.parse(stdout)))
      } catch {
        done(null)
      }
    })
  })
}
