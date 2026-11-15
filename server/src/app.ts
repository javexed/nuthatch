// The HTTP side: who a request is from, and the routes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { AgentRow, BackendStatus, QueryAnswer, Role, Session as SessionAnswer, StatsAnswer } from '@nuthatch/api'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import type { Htpasswd, Limiter } from './auth.ts'
import { type Agents, InstallCodes, type Pin, agentName, binaries, engineOf, installCommand, linuxScript, sshCommand, windowsScript } from './agents.ts'
import { nearestFirst, networksOf, probeCommand, readProbe, ufwGaps } from './reach.ts'
import { hostKeys, runOver, sshAddress, sshUser } from './ssh.ts'
import type { Backend } from './backend.ts'
import { COMMAND_NAMES, type Target, checkCommand, isService } from './commands.ts'
import { type ConfigAdmin, Conflict, Unverified } from './configadmin.ts'
import type { HostSetup } from './hostsetup.ts'
import { bodyOf, checkDraft, fromRow } from './dashboards.ts'
import { type TailnetMachine, askTailscale, discover } from './discover.ts'
import type { Events } from './events.ts'
import type { Graphs } from './graphs.ts'
import type { Pusher } from './push.ts'
import { ROLES, Refused, type Roles, type RolesConfig, TABLES, access, checkHeaders } from './policy.ts'
import { checkSubscription } from './webpush.ts'
import { Forbidden, combine, combineStats, limits, rows, stats } from './query.ts'
import { RemoteError, type RemoteSite } from './remote.ts'
import { type Store, now } from './store.ts'

export const VERSION = '0.0.0'
const COOKIE = 'nuthatch_session'
const CSRF_HEADER = 'x-nuthatch-csrf'

export interface Deps {
  backends: Backend[]
  store: Store
  events: Events
  roles: RolesConfig
  limiter: Limiter
  /** The users and their passwords; or, without it, `devUser`. */
  htpasswd?: Htpasswd
  /** Everyone is this user, and nobody logs in. */
  devUser?: string
  /**
   * Tailnet logins and the users they are, for requests that come through
   * `tailscale serve`, which names the tailnet user in Tailscale-User-Login
   * and drops any such header a client sent. Only for a loopback listen
   * behind it (main.ts sees to that).
   */
  tailscaleUsers?: Map<string, string>
  /** The tailnet's machines, in place of asking the local tailscale (tests). */
  tailnet?: () => Promise<TailnetMachine[] | null>
  /** The short history of performance data, for graphs; without it, there are none. */
  graphs?: Graphs
  /** Notifications pushed to browsers; without it, nobody can subscribe. */
  pusher?: Pusher
  /** Mark the session's cookie `Secure`: a proxy in front does TLS. */
  cookieSecure: boolean
  /** The built interface. */
  webRoot?: string
  /** By backend: the config that can be changed here. */
  config?: Map<string, ConfigAdmin>
  /** By backend: where its engine takes pushes (checkd's HTTP API), as jobs elsewhere reach it. */
  pushUrls?: Map<string, string>
  /** By backend: checkd's agents, which nuthatch adds and installs. */
  agents?: Map<string, Agents>
  /** What agents said their hosts are, and the checks proposed from it. */
  setup?: HostSetup
  /** The agent binaries, checkd's dist/agent. */
  agentBin?: string
  /** This nuthatch's address as monitored hosts reach it; else the request's. */
  agentBase?: string
  /** nuthatch's own TLS listener for hosts: its port, the addresses hosts
   * reach this machine at, and its certificate's pins. */
  agentListen?: { port: number; addresses: string[]; pin: Pin }
  /** Sites reached through their own nuthatch. */
  remotes?: RemoteSite[]
  /** The origins of apps served elsewhere (the phone app) that may call the API, with a token. */
  appOrigins?: string[]
  /** Other nuthatches that may ask here for their users. */
  peers?: Peer[]
}

/** A nuthatch elsewhere that shows this site to its users. */
export interface Peer {
  name: string
  /** The SHA-256 of its key, in hex. */
  keyHash: string
  /** It may send no commands and change no config. */
  readOnly: boolean
  /** It may change the config, for users who have the role here. */
  config: boolean
}

/** Who a request is from. */
interface Identity {
  user: string
  /** The session's cookie, when that is how they logged in. */
  cookie?: string
  csrf?: string
  /** Asked for by another nuthatch, for one of its users. */
  peer?: Peer
}

/** What nuthatch knows of a user, from the config and the backends. */
interface Who {
  roles: Roles
  /** Per backend: whether the contact of this name may send commands. */
  canSubmit: Record<string, boolean>
}

type Env = { Variables: { identity: Identity } }

/**
 * A name that can be a user's: it goes into Livestatus headers and command
 * lines, so it is one line without the separators of either.
 */
export function userName(name: unknown): name is string {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f;]/.test(name) && name.trim() === name
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

const WHO_FOR = 30_000

/** How many hosts or services one downtime for many may cover. */
const MANY = 500

export function buildApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>()
  const known = new Map<string, { who: Who; at: number }>()

  /**
   * The user's roles and command rights. The contact groups come from the
   * backends, and are remembered for half a minute.
   */
  async function who(user: string): Promise<Who> {
    const cached = known.get(user)
    if (cached && Date.now() - cached.at < WHO_FOR) return cached.who
    const groups = new Set<string>()
    const canSubmit: Record<string, boolean> = {}
    await Promise.all(
      deps.backends.map(async (backend) => {
        try {
          for (const [name, members] of await backend.query('GET contactgroups\nColumns: name members')) {
            if (typeof name === 'string' && Array.isArray(members) && members.includes(user)) groups.add(name)
          }
          const contact = await backend.query(`GET contacts\nColumns: can_submit_commands\nFilter: name = ${user}`)
          canSubmit[backend.name] = contact[0]?.[0] === 1
        } catch {
          canSubmit[backend.name] = false
        }
      }),
    )
    const found = { roles: deps.roles.resolve(user, [...groups]), canSubmit }
    known.set(user, { who: found, at: Date.now() })
    return found
  }

  const remotes = deps.remotes ?? []
  for (const site of remotes) void site.events((event, data) => deps.events.forward(event, data))

  /** Sorts backend names into those of this nuthatch and those of each site. None given means all. */
  function sites(names: string[]): { local: string[] | null; remote: { site: RemoteSite; names: string[] }[] } {
    if (names.length === 0) return { local: deps.backends.length > 0 ? [] : null, remote: remotes.map((site) => ({ site, names: [] })) }
    const local: string[] = []
    const remote = new Map<RemoteSite, string[]>()
    for (const name of names) {
      const site = remotes.find((r) => r.owns(name))
      if (site) remote.set(site, [...(remote.get(site) ?? []), name])
      else local.push(name)
    }
    return { local: local.length > 0 ? local : null, remote: [...remote].map(([site, names]) => ({ site, names })) }
  }

  const why = (err: unknown) => (err instanceof Error ? err.message : String(err))

  app.onError((err, c) => {
    if (err instanceof Forbidden) return c.json({ error: err.message }, 403)
    if (err instanceof Refused) return c.json({ error: err.message }, 400)
    if (err instanceof Conflict) return c.json({ error: err.message }, 409)
    if (err instanceof Unverified) return c.json({ error: err.message, output: err.output }, 422)
    // What a site answered goes on as it was.
    if (err instanceof RemoteError) return c.json({ ...err.detail, error: err.message }, err.status as 400)
    if (err instanceof SyntaxError) return c.json({ error: 'the body is not JSON' }, 400)
    console.error(err)
    return c.json({ error: 'nuthatch failed on this request; see its log' }, 500)
  })

  async function body(c: Context): Promise<Record<string, unknown>> {
    const parsed: unknown = await c.req.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Refused('the body is a JSON object')
    return parsed as Record<string, unknown>
  }

  // An app served from elsewhere, such as the phone app, may call the API
  // when its origin is listed. It gets no cookie: it logs in for a token.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin')
    const allowed = origin !== undefined && (deps.appOrigins ?? []).includes(origin)
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
    }
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403)
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
      c.header('Access-Control-Max-Age', '600')
      return c.body(null, 204)
    }
    return next()
  })

  // Before anyone is known.
  app.post('/api/v1/login', async (c) => {
    if (!deps.htpasswd) return c.json({ error: 'nobody logs in here: dev_user is set' }, 400)
    const { user, password, token: device } = await body(c)
    let address = 'unknown'
    try {
      address = getConnInfo(c).remote.address ?? 'unknown'
    } catch {
      // Not asked over a socket (a test).
    }
    // Behind a proxy every request comes from the proxy: counting failures
    // by that address would let anyone's five wrong passwords lock all
    // out. The client is then the last address the proxy wrote into
    // X-Forwarded-For, and without one failures count by user only.
    let client: string | undefined = address
    if (deps.cookieSecure) {
      const last = (c.req.header('X-Forwarded-For') ?? '').split(',').pop()?.trim() ?? ''
      client = /^[0-9A-Fa-f:.]{2,45}$/.test(last) ? last : undefined
      if (client !== undefined) address = client
    }
    const keys = [`user:${String(user)}`, ...(client === undefined ? [] : [`addr:${client}`])]
    if (deps.limiter.blocked(keys)) return c.json({ error: 'too many failed logins; wait five minutes' }, 429)
    if (!userName(user) || typeof password !== 'string' || !(await deps.htpasswd.check(user, password))) {
      deps.limiter.failed(keys)
      deps.store.audit(String(user).slice(0, 128), '', 'login failed', address)
      return c.json({ error: 'wrong user or password' }, 401)
    }
    deps.limiter.succeeded(keys[0] ?? '')
    if (typeof device === 'string') {
      // For an app: a token of its own in place of a session's cookie.
      // eslint-disable-next-line no-control-regex
      const name = device.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'app'
      const made = deps.store.newToken(user, name)
      deps.store.audit(user, '', 'login for a token', `${name} from ${address}`)
      return c.json({ user, token: made.token, id: made.id })
    }
    const { cookie, session } = deps.store.newSession(user)
    deps.store.audit(user, '', 'login', address)
    c.header('Set-Cookie', sessionCookie(cookie))
    return c.json({ user: session.user, csrf: session.csrf })
  })

  function sessionCookie(cookie: string): string {
    return `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${deps.cookieSecure ? '; Secure' : ''}`
  }

  /** The user a request's tailnet login is, when it is one of those listed. */
  function tailnetUser(c: Context): string | undefined {
    const login = c.req.header('tailscale-user-login')?.trim().toLowerCase()
    return login ? deps.tailscaleUsers?.get(login) : undefined
  }

  // Finds out who a request is from: an API token, a session's cookie, or
  // the dev user. A request that changes something and comes with a cookie
  // must also carry the session's CSRF value in a header, which a page of
  // another site cannot read or send.
  app.use('/api/*', async (c, next) => {
    let identity: Identity | undefined
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const peerKey = c.req.header('authorization')?.match(/^Peer (.+)$/)?.[1]
    const cookie = getCookie(c, COOKIE)
    if (peerKey !== undefined) {
      // Another nuthatch, with the key it was given, for one of its users.
      const hash = createHash('sha256').update(peerKey.trim()).digest()
      const peer = deps.peers?.find((p) => timingSafeEqual(Buffer.from(p.keyHash, 'hex'), hash))
      let user: string | undefined
      try {
        user = decodeURIComponent(c.req.header('x-nuthatch-user') ?? '')
      } catch {
        user = undefined
      }
      if (peer && userName(user)) identity = { user, peer }
      const path = c.req.path
      const passedOn = ['/api/v1/session', '/api/v1/query', '/api/v1/stats', '/api/v1/command', '/api/v1/events', '/api/v1/graph'].includes(path) || path.startsWith('/api/v1/config/')
      if (identity && !passedOn) return c.json({ error: 'not for another nuthatch' }, 403)
    } else if (bearer !== undefined) {
      const user = deps.store.tokenUser(bearer.trim())
      if (user !== null) identity = { user }
    } else if (cookie !== undefined) {
      const session = deps.store.session(cookie)
      if (session) identity = { user: session.user, cookie, csrf: session.csrf }
    } else if (deps.devUser !== undefined) {
      identity = { user: deps.devUser }
    }
    // Through tailscale serve, a listed tailnet login needs no password: it
    // gets a session as a login would, so the CSRF value guards what
    // changes things as it does after a login (the tailnet identity comes
    // with every request from the device, as a cookie does). A session of
    // someone else is ended first.
    const tailnet = peerKey === undefined && bearer === undefined ? tailnetUser(c) : undefined
    if (tailnet !== undefined && identity?.user !== tailnet) {
      if (identity?.cookie !== undefined) deps.store.endSession(identity.cookie)
      const made = deps.store.newSession(tailnet)
      deps.store.audit(tailnet, '', 'login by tailnet identity', c.req.header('tailscale-user-login')?.slice(0, 128) ?? '')
      c.header('Set-Cookie', sessionCookie(made.cookie))
      identity = { user: tailnet, cookie: made.cookie, csrf: made.session.csrf }
    }
    if (!identity) return c.json({ error: 'log in first' }, 401)
    const changes = c.req.method !== 'GET' && c.req.method !== 'HEAD'
    // What changes something is sent as JSON, which a page of another
    // site cannot send here without asking first (and is then refused):
    // it matters where no session's value is asked for, as with dev_user.
    const sends = Number(c.req.header('Content-Length') ?? 0) > 0 || c.req.header('Transfer-Encoding') !== undefined
    if (changes && sends && !(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'what changes something is sent as application/json' }, 415)
    }
    if (changes && identity.csrf !== undefined && c.req.header(CSRF_HEADER) !== identity.csrf) {
      return c.json({ error: `the header ${CSRF_HEADER} is missing or wrong` }, 403)
    }
    c.set('identity', identity)
    return next()
  })

  app.post('/api/v1/logout', (c) => {
    const { cookie } = c.get('identity')
    if (cookie !== undefined) deps.store.endSession(cookie)
    c.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    return c.json({})
  })

  // Who is logged in, what they may do, and how the backends are.
  app.get('/api/v1/session', async (c) => {
    const identity = c.get('identity')
    const { roles, canSubmit } = await who(identity.user)
    const system = roles.has('system_information')
    const backends: BackendStatus[] = await Promise.all(
      deps.backends.map(async (backend): Promise<BackendStatus> => {
        const limits_users = await backend.enforcesAuth()
        try {
          const [row] = await backend.query('GET status\nColumns: program_version livestatus_version program_start')
          const versions = system ? { program_version: row?.[0] as string, livestatus_version: row?.[1] as string, program_start: row?.[2] as number } : {}
          return { name: backend.name, ok: true, limits_users, ...versions }
        } catch (err) {
          return { name: backend.name, ok: false, limits_users, error: system && err instanceof Error ? err.message : 'not answering' }
        }
      }),
    )
    const configBackends = roles.has('config_edit') ? [...(deps.config?.keys() ?? [])] : []
    // The roles shown are for the interface to know what to offer: what
    // the user has here or at any site, and read-only when nowhere more.
    // What a user may do at a site is decided there.
    const held = new Set<Role>(roles)
    const readOnly = deps.backends.length > 0 ? [roles.has('read_only')] : []
    for (const site of remotes) {
      try {
        const theirs = await site.session(identity.user)
        for (const role of theirs.roles) held.add(role)
        readOnly.push(theirs.roles.includes('read_only'))
        backends.push(...theirs.backends)
        Object.assign(canSubmit, theirs.canSubmit)
        configBackends.push(...theirs.configBackends)
      } catch (err) {
        backends.push({ name: site.name, ok: false, limits_users: true, error: why(err) })
      }
    }
    const answer: SessionAnswer = {
      user: identity.user,
      roles: ROLES.filter((role) => (role === 'read_only' ? readOnly.length > 0 && readOnly.every(Boolean) : held.has(role))),
      can_submit_commands: canSubmit,
      csrf: identity.csrf ?? null,
      by_tailnet: tailnetUser(c) === identity.user,
      version: VERSION,
      commands: COMMAND_NAMES,
      tables: TABLES,
      backends,
      config_backends: configBackends,
      agent_backends: roles.has('config_edit') && deps.agentBin ? [...(deps.agents?.keys() ?? [])] : [],
    }
    return c.json(answer)
  })

  app.get('/api/v1/tokens', (c) => c.json(deps.store.tokens(c.get('identity').user)))

  app.post('/api/v1/tokens', async (c) => {
    const identity = c.get('identity')
    // A token is made by someone who logged in, not with another token.
    if (identity.cookie === undefined && deps.devUser === undefined) return c.json({ error: 'log in with a password to make a token' }, 403)
    // eslint-disable-next-line no-control-regex
    const name = String((await body(c)).name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64)
    const made = deps.store.newToken(identity.user, name)
    deps.store.audit(identity.user, '', 'token made', name)
    return c.json({ id: made.id, name, token: made.token })
  })

  app.delete('/api/v1/tokens/:id', (c) => {
    const { user } = c.get('identity')
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || !deps.store.deleteToken(user, id)) return c.json({ error: 'no such token' }, 404)
    deps.store.audit(user, '', 'token deleted', String(id))
    return c.json({})
  })

  app.get('/api/v1/prefs/:key', (c) => {
    const text = deps.store.pref(c.get('identity').user, c.req.param('key'))
    return c.json(text === null ? null : JSON.parse(text))
  })

  app.put('/api/v1/prefs/:key', async (c) => {
    const key = c.req.param('key')
    const text = JSON.stringify(await c.req.json())
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || text.length > 256 * 1024) {
      return c.json({ error: 'a preference has a short plain name and at most 256 kB' }, 400)
    }
    deps.store.setPref(c.get('identity').user, key, text)
    return c.json({})
  })

  /** The names a request gave under `backends`. */
  function named(sent: Record<string, unknown>): string[] {
    const names = sent.backends ?? []
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Refused('backends is a list of names')
    return names as string[]
  }

  /**
   * Asks this nuthatch's own backends and each site, and gives all the
   * answers. A part that failed is an error under its name, unless
   * nothing else was asked: then the failure is the answer.
   */
  async function everywhere<T extends { errors: Record<string, string> }>(
    user: string,
    sent: Record<string, unknown>,
    path: string,
    here: (names: string[]) => Promise<T>,
    empty: () => T,
  ): Promise<T[]> {
    const { local, remote } = sites(named(sent))
    const asks: Promise<T>[] = []
    const failed = (names: string[], err: unknown): T => ({ ...empty(), errors: Object.fromEntries(names.map((n) => [n, why(err)])) })
    if (local !== null) {
      asks.push(remote.length === 0 ? here(local) : here(local).catch((err) => failed(local.length > 0 ? local : deps.backends.map((b) => b.name), err)))
    }
    for (const { site, names } of remote) {
      const ask = site.ask<T>(user, path, sent, names)
      asks.push(local === null && remote.length === 1 ? ask : ask.catch((err) => failed(names.length > 0 ? names : [site.name], err)))
    }
    return Promise.all(asks)
  }

  app.post('/api/v1/query', async (c) => {
    const { user } = c.get('identity')
    const sent = await body(c)
    const { roles } = await who(user)
    if (remotes.length === 0) return c.json(await rows(deps.backends, user, roles, sent))
    // Each part gives its first rows; the page is cut from all of them.
    const offset = typeof sent.offset === 'number' && Number.isInteger(sent.offset) && sent.offset > 0 ? sent.offset : 0
    const limit = typeof sent.limit === 'number' && Number.isInteger(sent.limit) && sent.limit >= 0 ? sent.limit : undefined
    const sort = (Array.isArray(sent.sort) ? sent.sort : []).filter((k): k is { column: string; desc?: boolean } => typeof k?.column === 'string')
    const top = { ...sent, offset: 0, limit: limit === undefined ? undefined : offset + limit }
    const parts = await everywhere<QueryAnswer>(user, top, '/api/v1/query', (names) => rows(deps.backends, user, roles, { ...top, backends: names }), () => ({ rows: [], total: 0, errors: {} }))
    return c.json(combine(parts, sort, offset, limit))
  })

  app.post('/api/v1/stats', async (c) => {
    const { user } = c.get('identity')
    const sent = await body(c)
    const { roles } = await who(user)
    if (remotes.length === 0) return c.json(await stats(deps.backends, user, roles, sent))
    const parts = await everywhere<StatsAnswer>(user, sent, '/api/v1/stats', (names) => stats(deps.backends, user, roles, { ...sent, backends: names }), () => ({ groups: [], by_backend: {}, errors: {} }))
    // How each number is merged follows from the lines, whoever asks.
    const lines = Array.isArray(sent.headers) ? sent.headers.filter((h): h is string => typeof h === 'string') : []
    const everything = new Set<Role>(['configuration_information'])
    return c.json(combineStats(parts, checkHeaders(lines, true, everything)))
  })

  /**
   * Whether the user, as a contact, sees what a command is about: asked of
   * the engine with `AuthUser`, the way the lists are.
   */
  async function sees(backend: Backend, user: string, target: Target): Promise<boolean> {
    const auth = `AuthUser: ${user}`
    let request: string
    switch (target.kind) {
      case 'host':
        request = `GET hosts\nFilter: name = ${target.host}\n${auth}\nStats: state >= 0`
        break
      case 'service':
        request = `GET services\nFilter: host_name = ${target.host}\nFilter: description = ${target.service}\n${auth}\nStats: state >= 0`
        break
      default:
        request = `GET ${target.kind}s\nFilter: id = ${target.id}\nFilter: is_service = ${target.service ? 1 : 0}\n${auth}\nStats: id >= 0`
    }
    try {
      return (await backend.query(request))[0]?.[0] === 1
    } catch {
      return false
    }
  }

  /**
   * A downtime for every host, or every service, whose name fits: the
   * engine is asked which those are, as the user where the user's rights
   * are a contact's, and each gets the usual command. With `dry_run`,
   * only which they are.
   */
  app.post('/api/v1/downtime-many', async (c) => {
    const { user, peer } = c.get('identity')
    const sent = await body(c)
    if (peer?.readOnly) return c.json({ error: `${peer.name} may only read here` }, 403)
    const backend = deps.backends.find((b) => b.name === sent.backend)
    if (!backend) throw new Refused(`a downtime for many is set at the nuthatch of the site itself; there is no backend '${String(sent.backend)}' here`)
    const pattern = (value: unknown, what: string, needed: boolean): string => {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '' && !needed) return ''
      if (!/^[A-Za-z0-9@*?][A-Za-z0-9 _.:*?@+-]{0,62}$/.test(text)) throw new Refused(`${what}: a name, with * for any run of characters and ? for any one`)
      return text
    }
    const hosts = pattern(sent.hosts, 'hosts', true)
    const services = pattern(sent.services, 'services', false)
    const [start, end] = [Number(sent.start), Number(sent.end)]
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end <= now()) throw new Refused('a downtime ends after it starts, and not in the past')
    const comment = typeof sent.comment === 'string' && sent.comment.trim() !== '' ? sent.comment.trim() : 'downtime'
    const { roles, canSubmit } = await who(user)
    const byRole = roles.has('all_host_commands') || (services !== '' && roles.has('all_service_commands'))
    let refusal: string | undefined
    if (roles.has('read_only')) refusal = 'this user is read-only'
    else if (byRole) refusal = undefined
    else if (canSubmit[backend.name] !== true) refusal = 'this user is not a contact that may send commands (can_submit_commands)'
    else if (!(await backend.enforcesAuth())) refusal = 'this backend does not limit what a user sees (AuthUser); commands need the role all_host_commands here'
    if (refusal !== undefined) {
      deps.store.audit(user, backend.name, 'command refused', `downtime for ${hosts}/${services}: ${refusal}`)
      return c.json({ error: refusal }, 403)
    }
    // A pattern as a regular expression that is the whole name.
    const whole = (glob: string) => `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
    const lines = [services === '' ? 'GET hosts\nColumns: name' : 'GET services\nColumns: host_name description']
    if (hosts.startsWith('@')) lines.push(`Filter: ${services === '' ? 'groups' : 'host_groups'} >= ${hosts.slice(1)}`)
    else lines.push(`Filter: ${services === '' ? 'name' : 'host_name'} ~ ${whole(hosts)}`)
    if (services !== '') lines.push(`Filter: description ~ ${whole(services)}`)
    // By a contact's rights: only what the engine shows that contact.
    if (!byRole) lines.push(`AuthUser: ${user}`)
    lines.push(`Limit: ${MANY + 1}`)
    const found = await backend.query(lines.join('\n'))
    if (found.length > MANY) throw new Refused(`more than ${MANY} fit; narrow it`)
    const matches = found.map((row) => row.map(String)).sort((a, b) => a.join('/').localeCompare(b.join('/')))
    if (sent.dry_run === true) return c.json({ matches })
    for (const match of matches) {
      const name = services === '' ? 'SCHEDULE_HOST_DOWNTIME' : 'SCHEDULE_SVC_DOWNTIME'
      const checked = checkCommand(name, [...match, String(start), String(end), '1', '0', '0', '', comment], user, now())
      await backend.command(checked.line)
    }
    deps.store.audit(user, backend.name, 'command', `downtime for ${matches.length} that fit ${hosts}${services === '' ? '' : `/${services}`}, ${start} to ${end}: ${comment}`.slice(0, 500))
    return c.json({ matches })
  })

  /**
   * How a service takes pushes, for those who may see the engine's
   * config: the token is all a caller needs.
   */
  /**
   * The members of a service that stands for others (`checkd:aggregate`),
   * each with its state, as far as the user sees them.
   */
  app.get('/api/v1/aggregate/:backend', async (c) => {
    const { user } = c.get('identity')
    const backend = deps.backends.find((b) => b.name === c.req.param('backend'))
    const [host, service] = [c.req.query('host') ?? '', c.req.query('service') ?? '']
    if (!backend || /[\n\r]/.test(host + service) || host === '' || service === '') return c.json({ aggregate: false })
    const { roles } = await who(user)
    const how = access('services', roles)
    if (how.kind === 'limited' && !(await sees(backend, user, { kind: 'service', host, service }))) throw new Forbidden("not one of this user's services")
    const [row] = await backend.query(`GET services\nColumns: check_command\nFilter: host_name = ${host}\nFilter: description = ${service}`)
    const [name = '', ...args] = String(row?.[0] ?? '').split('!')
    if (/[\n\r]/.test(name) || name === '') return c.json({ aggregate: false })
    const [command] = await backend.query(`GET commands\nColumns: line\nFilter: name = ${name}`)
    const line = String(command?.[0] ?? '').replace(/\$ARG(\d+)\$/g, (_, n: string) => args[Number(n) - 1] ?? '').trim()
    if (!line.startsWith('checkd:aggregate')) return c.json({ aggregate: false })
    const words = [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '').slice(1)
    const min = words[0] === '--min' ? words[1] : undefined
    const patterns = (min === undefined ? words : words.slice(2)).slice(0, 40)
    const whole = (glob: string) => `^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
    const members: { host: string; service?: string; state: number; checked: boolean }[] = []
    for (const pattern of patterns) {
      if (/[\n\r]/.test(pattern)) continue
      const [hosts = '', services = ''] = pattern.split(/\/(.*)/s)
      const hostFilter = hosts.startsWith('@') ? `Filter: ${services ? 'host_groups' : 'groups'} >= ${hosts.slice(1)}` : `Filter: ${services ? 'host_name' : 'name'} ~ ${whole(hosts)}`
      const request = services
        ? `GET services\nColumns: host_name description state has_been_checked\n${hostFilter}\nFilter: description ~ ${whole(services)}\n${limits('services', how, user)}Limit: 200`
        : `GET hosts\nColumns: name state has_been_checked\n${hostFilter}\n${limits('hosts', access('hosts', roles), user)}Limit: 200`
      for (const r of await backend.query(request)) {
        const member = services
          ? { host: String(r[0]), service: String(r[1]), state: Number(r[2]), checked: r[3] === 1 }
          : { host: String(r[0]), state: Number(r[1]), checked: r[2] === 1 }
        if (member.host === host && member.service === service) continue
        if (!members.some((m) => m.host === member.host && m.service === member.service)) members.push(member)
      }
    }
    return c.json({ aggregate: true, ...(min ? { min } : {}), members })
  })

  /** The services that take pushes, for those who may see the config. */
  app.get('/api/v1/pushed', async (c) => {
    const { user } = c.get('identity')
    const { roles } = await who(user)
    if (!roles.has('config_edit') && !roles.has('configuration_information')) throw new Forbidden('needs the role config_edit or configuration_information')
    const out: { backend: string; host: string; service: string; state: number; last: number; output: string }[] = []
    for (const backend of deps.backends) {
      try {
        const found = await backend.query('GET services\nColumns: host_name description state last_check plugin_output\nFilter: custom_variable_names >= CHECKD_PUSH_TOKEN')
        for (const r of found) out.push({ backend: backend.name, host: String(r[0]), service: String(r[1]), state: Number(r[2]), last: Number(r[3]) || 0, output: String(r[4] ?? '') })
      } catch {
        // A backend that does not answer has none to show.
      }
    }
    return c.json({ services: out.sort((a, b) => a.host.localeCompare(b.host) || a.service.localeCompare(b.service)) })
  })

  app.get('/api/v1/push-info/:backend', async (c) => {
    const { user } = c.get('identity')
    const { roles } = await who(user)
    if (!roles.has('config_edit') && !roles.has('configuration_information')) throw new Forbidden('how a service takes pushes is shown to those who see the config')
    const backend = deps.backends.find((b) => b.name === c.req.param('backend'))
    const [host, service] = [c.req.query('host') ?? '', c.req.query('service') ?? '']
    if (!backend || /[\n\r]/.test(host + service) || host === '' || service === '') return c.json({ takes: false })
    const found = await backend.query(
      `GET services\nColumns: custom_variable_names custom_variable_values last_check\nFilter: host_name = ${host}\nFilter: description = ${service}`,
    )
    const [names, values, last] = (found[0] ?? []) as [unknown, unknown, unknown]
    const variable = (name: string) => (Array.isArray(names) && Array.isArray(values) ? values[names.indexOf(name)] : undefined)
    const token = names instanceof Array && names.includes('CHECKD_PUSH_TOKEN') ? String(variable('CHECKD_PUSH_TOKEN')) : undefined
    if (token === undefined) return c.json({ takes: false })
    // Within how long a push is expected is the service's freshness
    // threshold, which Livestatus does not give: known for a service
    // nuthatch keeps.
    let every = 0
    const admin = deps.config?.get(backend.name)
    if (admin) {
      try {
        every = (await admin.state()).hosts.find((h) => h.name === host)?.services.find((s) => s.description === service)?.push?.every ?? 0
      } catch {
        // Then it is not said.
      }
    }
    const base = deps.pushUrls?.get(backend.name)
    return c.json({
      takes: true,
      path: `/api/v1/push/${token}`,
      ...(base ? { url: `${base.replace(/\/+$/, '')}/api/v1/push/${token}` } : {}),
      ...(Number.isFinite(every) && every > 0 ? { every } : {}),
      last: Number(last) || 0,
    })
  })

  app.post('/api/v1/command', async (c) => {
    const { user, peer } = c.get('identity')
    const sent = await body(c)
    if (peer?.readOnly) return c.json({ error: `${peer.name} may only read here` }, 403)
    const site = remotes.find((r) => typeof sent.backend === 'string' && r.owns(sent.backend))
    if (site) {
      // The site decides, and keeps its own record of it.
      const line = `${String(sent.command)};${Array.isArray(sent.args) ? sent.args.join(';') : ''}`.slice(0, 500)
      try {
        await site.session(user)
        const passed = await site.call(user, 'POST', '/api/v1/command', { ...sent, backend: site.theirs(sent.backend as string) ?? sent.backend })
        deps.store.audit(user, String(sent.backend), 'command passed on', line)
        return c.json(passed)
      } catch (err) {
        deps.store.audit(user, String(sent.backend), 'command refused', `${line}: ${why(err)}`)
        throw err
      }
    }
    const backend = deps.backends.find((b) => b.name === sent.backend)
    if (!backend) return c.json({ error: `no backend '${String(sent.backend)}'` }, 400)
    if (typeof sent.command !== 'string' || !Array.isArray(sent.args) || sent.args.some((a) => typeof a !== 'string')) {
      throw new Refused('a command has a name and a list of arguments, as texts')
    }
    const checked = checkCommand(sent.command, sent.args as string[], user, now())
    const { roles, canSubmit } = await who(user)
    const byRole = roles.has('all_host_commands') || (isService(checked.target) && roles.has('all_service_commands'))
    let refusal: string | undefined
    if (roles.has('read_only')) refusal = 'this user is read-only'
    else if (byRole) refusal = undefined
    else if (canSubmit[backend.name] !== true) refusal = 'this user is not a contact that may send commands (can_submit_commands)'
    else if (!(await backend.enforcesAuth())) {
      refusal = 'this backend does not limit what a user sees (AuthUser); commands need the role all_host_commands here'
    } else if (!(await sees(backend, user, checked.target))) refusal = "not one of this user's hosts or services"
    if (refusal !== undefined) {
      deps.store.audit(user, backend.name, 'command refused', `${checked.line}: ${refusal}`)
      return c.json({ error: refusal }, 403)
    }
    try {
      await backend.command(checked.line)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
    deps.store.audit(user, backend.name, 'command', peer ? `${checked.line} (through ${peer.name})` : checked.line)
    if (/^SCHEDULE_(FORCED_)?(HOST|SVC|HOST_SVC)_CHECKS?$/.test(sent.command)) deps.events.expectCheck(backend.name)
    return c.json({ sent: checked.line })
  })

  app.get('/api/v1/audit', async (c) => {
    if (!(await who(c.get('identity').user)).roles.has('system_information')) {
      return c.json({ error: 'the audit log needs the role system_information' }, 403)
    }
    return c.json(deps.store.auditTail(500))
  })

  // Dashboards: the user's own, and those shared with everyone.
  app.get('/api/v1/dashboards', (c) => c.json(deps.store.dashboards(c.get('identity').user).map(fromRow)))

  app.get('/api/v1/dashboards/:id', (c) => {
    const row = deps.store.dashboard(c.get('identity').user, Number(c.req.param('id')))
    return row ? c.json(fromRow(row)) : c.json({ error: 'no such dashboard' }, 404)
  })

  app.post('/api/v1/dashboards', async (c) => {
    const { user } = c.get('identity')
    const draft = checkDraft(await body(c))
    const id = deps.store.newDashboard(user, draft.title, draft.shared, bodyOf(draft))
    const row = deps.store.dashboard(user, id)
    return row ? c.json(fromRow(row)) : c.json({ error: 'not kept' }, 500)
  })

  app.put('/api/v1/dashboards/:id', async (c) => {
    const { user } = c.get('identity')
    const id = Number(c.req.param('id'))
    const draft = checkDraft(await body(c))
    // Its owner, or anyone for a shared one.
    if (!Number.isInteger(id) || !deps.store.saveDashboard(user, id, draft.title, draft.shared, bodyOf(draft))) {
      return c.json({ error: 'not found' }, 404)
    }
    const row = deps.store.dashboard(user, id)
    return row ? c.json(fromRow(row)) : c.json({ error: 'not kept' }, 500)
  })

  app.delete('/api/v1/dashboards/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || !deps.store.deleteDashboard(c.get('identity').user, id)) return c.json({ error: 'no such dashboard of yours' }, 404)
    return c.json({})
  })

  // Changing the config, for one role.
  async function configOf(c: Context<Env>): Promise<{ admin: ConfigAdmin; user: string }> {
    const { user, peer } = c.get('identity')
    if (peer && (peer.readOnly || !peer.config)) throw new Forbidden(`${peer.name} may not change the config here`)
    if (!(await who(user)).roles.has('config_edit')) throw new Forbidden('changing the config needs the role config_edit')
    const admin = deps.config?.get(c.req.param('backend') ?? '')
    if (!admin) throw new Refused(`the config of '${c.req.param('backend')}' cannot be changed here`)
    return { admin, user }
  }

  /** The site whose backend a config request names, with the site's name for it. */
  async function configSite(c: Context<Env>): Promise<{ site: RemoteSite; path: string } | undefined> {
    const name = c.req.param('backend') ?? ''
    const site = remotes.find((r) => r.owns(name))
    if (!site) return undefined
    await site.session(c.get('identity').user)
    return { site, path: `/api/v1/config/${encodeURIComponent(site.theirs(name) ?? name)}` }
  }

  app.get('/api/v1/config/:backend', async (c) => {
    const far = await configSite(c)
    if (far) return c.json({ ...(await far.site.call<Record<string, unknown>>(c.get('identity').user, 'GET', far.path)), backend: c.req.param('backend') })
    return c.json(await (await configOf(c)).admin.state())
  })

  app.post('/api/v1/config/:backend', async (c) => {
    const far = await configSite(c)
    if (far) {
      const { user } = c.get('identity')
      const sent = await body(c)
      const result = await far.site.call(user, 'POST', far.path, sent)
      if (sent.dry_run !== true) deps.store.audit(user, c.req.param('backend'), 'config passed on', JSON.stringify(sent.change).slice(0, 200))
      return c.json(result)
    }
    const { admin, user } = await configOf(c)
    const backend = c.req.param('backend')
    const sent = await body(c)
    const change = sent.change as { kind?: string; name?: unknown; host?: { name?: unknown }; group?: { name?: unknown }; contact?: { name?: unknown } } | undefined
    if (typeof change !== 'object' || change === null || !['put', 'delete', 'put-group', 'delete-group', 'put-contact', 'delete-contact'].includes(String(change.kind))) {
      throw new Refused('a change is a put, a delete, a put-group or a delete-group')
    }
    const dryRun = sent.dry_run === true
    const what = `${change.kind} ${String(change.kind === 'put' ? change.host?.name : change.kind === 'put-group' ? change.group?.name : change.kind === 'put-contact' ? change.contact?.name : change.name)}`
    try {
      const result = await admin.change(sent.revision, change as never, dryRun)
      if (!dryRun) deps.store.audit(user, backend, 'config', what)
      return c.json(result)
    } catch (err) {
      if (!dryRun) deps.store.audit(user, backend, 'config refused', `${what}: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  })

  // The graphs of a host or a service: its performance data over the last
  // hours. For those who see it, as the lists decide.
  app.get('/api/v1/graph', async (c) => {
    const { user } = c.get('identity')
    const name = c.req.query('backend') ?? ''
    const host = c.req.query('host') ?? ''
    const service = c.req.query('service') ?? ''
    const hours = Math.min(24 * 92, Math.max(1, Number(c.req.query('hours')) || 24))
    // Or from one moment to another, at most 92 days apart.
    const from = Number(c.req.query('from'))
    const to = Number(c.req.query('to'))
    const span = Number.isFinite(from) && Number.isFinite(to) && to > from && c.req.query('from') !== undefined ? { from: Math.max(from, to - 92 * 86400), to } : null
    const over = span ?? hours
    if (/[\r\n]/.test(host + service) || host === '') throw new Refused('a graph is of a host, or of a host and a service')
    const site = remotes.find((r) => r.owns(name))
    if (site) {
      await site.session(user)
      const query = new URLSearchParams({ backend: site.theirs(name) ?? name, host, service, ...(span ? { from: String(span.from), to: String(span.to) } : { hours: String(hours) }) })
      return c.json(await site.call(user, 'GET', `/api/v1/graph?${query.toString()}`))
    }
    const backend = deps.backends.find((b) => b.name === name)
    if (!backend) throw new Refused(`no backend '${name}'`)
    if (!deps.graphs) return c.json({ enabled: false, series: [] })
    const { roles } = await who(user)
    const all = roles.has('all_hosts') || (service !== '' && roles.has('all_services'))
    if (!all) {
      const limited = await backend.enforcesAuth()
      const target: Target = service === '' ? { kind: 'host', host } : { kind: 'service', host, service }
      if (!limited || !(await sees(backend, user, target))) throw new Forbidden("not one of this user's hosts or services")
    }
    return c.json({ enabled: true, series: deps.graphs.series(name, host, service, over) })
  })

  // Notifications pushed to this user's browsers.
  app.get('/api/v1/notifications', (c) => {
    const { user } = c.get('identity')
    if (!deps.pusher) return c.json({ enabled: false, devices: [] })
    return c.json({
      enabled: true,
      key: deps.pusher.keys.publicKey,
      devices: deps.store.pushOf(user).map((row) => ({ name: row.name, created: row.created, endpoint: row.endpoint })),
    })
  })

  app.post('/api/v1/notifications', async (c) => {
    const { user } = c.get('identity')
    if (!deps.pusher) throw new Refused('notifications are not set up on this server ([notifications] in its config)')
    const sent = await body(c)
    let subscription
    try {
      subscription = checkSubscription(sent.subscription)
    } catch (err) {
      throw new Refused(err instanceof Error ? err.message : String(err))
    }
    // eslint-disable-next-line no-control-regex
    const name = (typeof sent.name === 'string' ? sent.name : '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'a browser'
    if (deps.store.pushOf(user).length >= 20 && !deps.store.pushOf(user).some((row) => row.endpoint === subscription.endpoint)) {
      throw new Refused('twenty browsers are subscribed already; take one out first')
    }
    deps.store.addPush(user, subscription, name)
    deps.store.audit(user, '', 'push subscribed', name)
    return c.json({})
  })

  app.post('/api/v1/notifications/remove', async (c) => {
    const { user } = c.get('identity')
    const { endpoint } = await body(c)
    if (typeof endpoint !== 'string' || !deps.store.removePush(endpoint, user)) throw new Refused('no such subscription')
    return c.json({})
  })

  app.post('/api/v1/notifications/test', async (c) => {
    const { user } = c.get('identity')
    if (!deps.pusher) throw new Refused('notifications are not set up on this server')
    const counts = await deps.pusher.toUser(user, { title: 'nuthatch', body: 'Notifications reach this device.', url: '', tag: 'nuthatch-test' }, false)
    return c.json(counts)
  })

  // Looking at a host before adding it: from where its engine runs, so a
  // site's nuthatch looks for a backend of that site.
  app.post('/api/v1/config/:backend/discover', async (c) => {
    const far = await configSite(c)
    const { target, also } = await body(c)
    if (far) return c.json(await far.site.call(c.get('identity').user, 'POST', `${far.path}/discover`, { target, also }))
    const { user } = await configOf(c)
    deps.store.audit(user, c.req.param('backend'), 'looked at a host', String(target).slice(0, 200))
    return c.json(await discover(target, also ?? []))
  })

  // The tailnet's machines that the engine has no host for yet, to add one
  // from: as the tailscale on the engine's machine knows them.
  app.get('/api/v1/config/:backend/machines', async (c) => {
    const far = await configSite(c)
    if (far) return c.json(await far.site.call(c.get('identity').user, 'GET', `${far.path}/machines`))
    await configOf(c)
    const backend = deps.backends.find((b) => b.name === c.req.param('backend'))
    const machines = await (deps.tailnet ?? askTailscale)()
    if (machines === null || !backend) return c.json({ available: false, machines: [] })
    const known = new Set<string>()
    for (const row of await backend.query('GET hosts\nColumns: name address')) for (const value of row) known.add(String(value).toLowerCase().replace(/\.$/, ''))
    return c.json({ available: true, machines: machines.filter((m) => !known.has(m.address) && !known.has(m.name)) })
  })

  app.get('/api/v1/events', (c) =>
    streamSSE(c, async (stream) => {
      const stop = deps.events.listen((event, data) => void stream.writeSSE({ event, data }))
      stream.onAbort(stop)
      // A line every 15 seconds keeps proxies from closing the stream.
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(15_000)
        await stream.write(': keep-alive\n\n')
      }
      stop()
    }),
  )

  // Agents: for the role config_edit, on this site's own backends.
  const codes = new InstallCodes()
  /** Installs over SSH under way or just done, by id: in memory, an hour. */
  interface Job {
    owner: string
    output: string
    done: boolean
    ok: boolean
    at: number
  }
  const jobs = new Map<string, Job>()
  async function agentsOf(c: Context<Env>): Promise<{ agents: Agents; user: string }> {
    const { user, peer } = c.get('identity')
    if (peer) throw new Forbidden('agents are added at their own site')
    if (!(await who(user)).roles.has('config_edit')) throw new Forbidden('agents need the role config_edit')
    const agents = deps.agents?.get(c.req.param('backend') ?? '')
    if (!agents || !deps.agentBin) throw new Refused(`no agents for '${c.req.param('backend')}' here`)
    return { agents, user }
  }
  /** Who fetched, for the audit log: behind a proxy, its last X-Forwarded-For. */
  function address(c: Context<Env>): string {
    // On nuthatch's own TLS listener nobody stands between: no proxy's header.
    const direct = (c.env as { incoming?: { socket?: { encrypted?: boolean } } } | undefined)?.incoming?.socket?.encrypted === true
    if (deps.cookieSecure && !direct) {
      const last = (c.req.header('X-Forwarded-For') ?? '').split(',').pop()?.trim() ?? ''
      if (/^[0-9A-Fa-f:.]{2,45}$/.test(last)) return last
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
  function baseOf(c: Context<Env>): string {
    if (deps.agentBase) return deps.agentBase
    const url = new URL(c.req.url)
    const host = c.req.header('host') ?? url.host
    return `${deps.cookieSecure ? 'https:' : url.protocol}//${host}`
  }

  /** An agent's row, with its system and its waiting proposals. */
  async function rowOf(agents: Agents, row: AgentRow): Promise<AgentRow> {
    const backend = agents.backend.name
    const kept = deps.setup ? await deps.setup.view(backend, row.host).catch(() => null) : null
    return { ...row, ...(kept ? { os: kept.inventory.os.name || kept.inventory.os.family, proposals: kept.proposals.length } : {}) }
  }

  /** The ports a host's agent comes in at, on this machine: nuthatch's
   * listener, and the engine's when it is on this machine too. */
  function agentPorts(agents: Agents): number[] {
    const listen = deps.agentListen
    if (!listen) return []
    const engine = /^:(\d+)$/.exec(agents.settings.engine)?.[1]
    return [listen.port, ...(engine ? [Number(engine)] : [])]
  }

  app.get('/api/v1/agents/:backend', async (c) => {
    const { agents } = await agentsOf(c)
    const rows = await Promise.all((await agents.list()).map((row) => rowOf(agents, row)))
    const listen = deps.agentListen
    if (!listen) return c.json({ agents: rows })
    // For a host: the address on its network first.
    const host = c.req.query('host')
    let addresses = listen.addresses
    if (host && agentName(host)) {
      const found = await agents.backend.query(`GET hosts\nColumns: address\nFilter: name = ${host}`).catch(() => [])
      addresses = await nearestFirst(addresses, String(found[0]?.[0] ?? '') || undefined)
    }
    const firewall = ufwGaps(agentPorts(agents), [...networksOf(listen.addresses).values()])
    return c.json({ agents: rows, addresses, ...(firewall.length ? { firewall } : {}) })
  })

  app.get('/api/v1/agents/:backend/:host/inventory', async (c) => {
    const { agents } = await agentsOf(c)
    const host = c.req.param('host')
    if (!agentName(host)) throw new Refused('a host name of letters, digits, ., - and _')
    // Taken up at once, not at the next look round.
    const file = agents.inventoryFile(host)
    if (file && deps.setup && agents.hosts().includes(host)) await deps.setup.take(agents.backend.name, host, file.text, file.received)
    const row = (await agents.list()).find((r) => r.host === host)
    return c.json({ inventory: deps.setup ? await deps.setup.view(agents.backend.name, host) : null, agent: row ? await rowOf(agents, row) : null })
  })

  app.post('/api/v1/agents/:backend/:host/proposals', async (c) => {
    const { agents, user } = await agentsOf(c)
    const host = c.req.param('host')
    if (!agentName(host) || !deps.setup) throw new Refused('no such host')
    const sent = await body(c)
    try {
      const added = await deps.setup.decide(agents.backend.name, host, sent.add, sent.dismiss)
      if (added.length > 0) deps.store.audit(user, agents.backend.name, 'config', `checks of ${host}: ${added.join(', ')}`)
      return c.json({ added })
    } catch (err) {
      if (err instanceof Unverified) return c.json({ error: err.message, output: err.output }, 422)
      if (err instanceof Conflict) return c.json({ error: err.message }, 409)
      throw err
    }
  })

  /** What an install is for, checked, and nuthatch's address for the host. */
  function planOf(c: Context<Env>, agents: Agents, sent: Record<string, unknown>) {
    const { host, os } = sent
    if (!agentName(host)) throw new Refused('a host name of letters, digits, ., - and _')
    if (os !== 'linux' && os !== 'windows') throw new Refused('os is linux or windows')
    const nrpe = os === 'linux' && sent.nrpe === true
    if (nrpe && /^wss?:/.test(agents.settings.engine)) throw new Refused('NRPE needs the engine to reach the host, which it does not through a proxy or tunnel')
    let base: string
    let at: string
    const listen = deps.agentListen
    if (listen) {
      // nuthatch's own listener, its certificate checked by its pins.
      at = typeof sent.address === 'string' && sent.address !== '' ? sent.address : (listen.addresses[0] ?? '')
      if (!listen.addresses.includes(at)) throw new Refused(`address is one of ${listen.addresses.join(', ')}`)
      base = `https://${at.includes(':') ? `[${at}]` : at}:${listen.port}`
    } else {
      // The script carries a token and is run as root: never over plain
      // HTTP, but to this machine itself.
      base = baseOf(c)
      if (!base.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) {
        throw new Refused('install commands need nuthatch at an https address: set url or listen under [agents]')
      }
      if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(\/[A-Za-z0-9._~/-]*)?$/.test(base)) throw new Refused('this address cannot go into a command; set url under [agents]')
      at = new URL(base).hostname.replace(/^\[|\]$/g, '')
    }
    return { host, os, nrpe, plugins: sent.plugins === true, base, at, pin: listen?.pin } as const
  }

  /** A new token and a one-use code for a planned install. */
  async function issue(agents: Agents, plan: ReturnType<typeof planOf>) {
    const token = await agents.add(plan.host)
    const install = { backend: agents.backend.name, host: plan.host, token, os: plan.os, nrpe: plan.nrpe, plugins: plan.plugins, base: plan.base, address: plan.at, ...(plan.pin ? { pin: plan.pin } : {}) }
    const { code, until } = codes.make(install)
    agents.noteIssued(plan.host, new URL(plan.base).host, engineOf(install, agents.settings).replace(/^wss?:\/\//, ''))
    return { install, until, url: `${plan.base}/agent/install/${code}` }
  }

  app.post('/api/v1/agents/:backend', async (c) => {
    const { agents, user } = await agentsOf(c)
    const plan = planOf(c, agents, await body(c))
    const { install, until, url } = await issue(agents, plan)
    deps.store.audit(user, agents.backend.name, 'agent', `${plan.host} (${plan.os}${plan.nrpe ? ', nrpe' : ''})`)
    return c.json({ until, command: installCommand(install, url) })
  })

  // Over SSH: nuthatch logs in to the host and runs the command itself,
  // with a login given for this run alone and kept nowhere.
  app.post('/api/v1/agents/:backend/ssh-keys', async (c) => {
    await agentsOf(c)
    const sent = await body(c)
    const port = sent.port === undefined ? 22 : sent.port
    if (!sshAddress(sent.address) || typeof port !== 'number') throw new Refused('an address, and a port')
    const keys = await hostKeys(sent.address, port)
    if (keys.length === 0) throw new Refused(`no SSH server answered at ${sent.address}:${port}`)
    return c.json({ keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) })
  })

  app.post('/api/v1/agents/:backend/ssh', async (c) => {
    const { agents, user } = await agentsOf(c)
    const sent = await body(c)
    const plan = planOf(c, agents, sent)
    const login = (typeof sent.ssh === 'object' && sent.ssh !== null ? sent.ssh : {}) as Record<string, unknown>
    const port = login.port === undefined ? 22 : login.port
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
    if (!sshAddress(login.address) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Refused('an SSH address and port')
    if (!sshUser(login.user)) throw new Refused('an SSH user')
    const password = text(login.password)
    const key = text(login.key)
    if (!password === !key) throw new Refused('a password or a key')
    const seenKeys = (await hostKeys(login.address, port)).filter((k) => k.fingerprint === login.fingerprint)
    if (seenKeys.length === 0) throw new Refused("the host's key is not the one shown: fetch it again")
    const sudo = text(login.sudo_password) ?? password ?? ''
    const id = randomBytes(12).toString('base64url')
    const job: Job = { owner: user, output: '', done: false, ok: false, at: Date.now() }
    for (const [old, held] of jobs) if (Date.now() - held.at > 3600_000) jobs.delete(old)
    jobs.set(id, job)
    const where = `${login.user}@${login.address}:${port}`
    deps.store.audit(user, agents.backend.name, 'agent over ssh', `${plan.host} (${plan.os}${plan.nrpe ? ', nrpe' : ''}) as ${where}`)
    const sshLogin = { address: login.address, port, user: login.user, password, key, passphrase: text(login.passphrase) }
    const say = (more: string) => {
      job.output = (job.output + more).slice(-65536)
    }
    // First, from the host: does it reach this machine at the agent ports?
    // The address it reaches is the one its agent is given.
    const reachable = async (): Promise<typeof plan | null> => {
      const listen = deps.agentListen
      const ports = agentPorts(agents)
      if (!listen || ports.length === 0) return plan
      const order = [plan.at, ...listen.addresses.filter((a) => a !== plan.at)]
      say(`Can ${plan.host} reach this machine (port ${ports.join(' and ')})?\n`)
      let probed = ''
      const code = await runOver(sshLogin, seenKeys, probeCommand(plan.os, order, ports), '', (more) => (probed += more), 2 * 60_000)
      const { reached, missed } = readProbe(probed)
      if (code === 255 && reached.length === 0 && missed.size === 0) {
        say(probed)
        return null
      }
      for (const a of order) say(reached.includes(a) ? `  ${a}: yes\n` : missed.has(a) ? `  ${a}: no (port ${missed.get(a)?.join(', ')})\n` : '')
      const at = order.find((a) => reached.includes(a))
      if (at === undefined) {
        if (missed.size === 0) {
          // The host could not run the check: install anyway, as asked.
          say(probed.trim() ? `${probed.trim()}\n` : '')
          return plan
        }
        const gaps = ufwGaps(ports, [...networksOf(listen.addresses).values()])
        say(`\n${plan.host} cannot reach this machine, so its agent could not connect. Nothing was installed.\n`)
        say(gaps.length ? `This machine's firewall keeps it out. Here, run:\n${[...new Set(gaps.map((g) => `  ${g.command}`))].join('\n')}\n` : `A firewall here or on ${plan.host} may keep it out.\n`)
        return null
      }
      return at === plan.at ? plan : { ...plan, at, base: `https://${at.includes(':') ? `[${at}]` : at}:${listen.port}` }
    }
    void reachable()
      .then(async (checked) => {
        // Not reachable: said why already.
        if (!checked) return -1
        const { install, url } = await issue(agents, checked)
        if (checked.at !== plan.at) say(`Using ${checked.at}.\n`)
        say('\n')
        return runOver(sshLogin, seenKeys, sshCommand(install, url, sshLogin.user), plan.os === 'linux' && sshLogin.user !== 'root' ? `${sudo}\n` : '', say)
      })
      .then((code) => {
        job.ok = code === 0
        if (/Host key verification failed/.test(job.output)) job.output = "The host's key is not the one shown."
        else if (code === 255 && /kex_exchange_identification|Connection reset by/.test(job.output)) job.output += '\nThe SSH server refused the connection. After a wrong login it may refuse for a while: try again in a minute.'
        else if (code > 0) job.output += `\n(exit ${code})`
      })
      .catch((err: unknown) => {
        job.output += `\n${err instanceof Error ? err.message : String(err)}`
      })
      .finally(() => {
        job.done = true
        deps.store.audit(user, agents.backend.name, job.ok ? 'agent over ssh done' : 'agent over ssh failed', `${plan.host} as ${where}`)
      })
    return c.json({ job: id })
  })

  app.get('/api/v1/agents/jobs/:id', async (c) => {
    const { user } = c.get('identity')
    const job = jobs.get(c.req.param('id'))
    if (!job || job.owner !== user) return c.json({ error: 'no such job' }, 404)
    return c.json({ done: job.done, ok: job.ok, output: job.output })
  })

  app.delete('/api/v1/agents/:backend/:host', async (c) => {
    const { agents, user } = await agentsOf(c)
    const host = c.req.param('host')
    if (!(await agents.remove(host))) return c.json({ error: 'no such agent' }, 404)
    deps.setup?.forget(agents.backend.name, host)
    deps.store.audit(user, agents.backend.name, 'agent removed', host)
    return c.json({})
  })

  app.all('/api/*', (c) => c.json({ error: 'no such thing' }, 404))

  // What a monitored host fetches: its install script, once, by its code;
  // and the agent binaries, which hold nothing secret.
  app.get('/agent/install/:code', (c) => {
    // A look ahead (HEAD, a link preview) does not use the code up.
    if (c.req.method === 'HEAD') return c.body(null, 200)
    const install = codes.take(c.req.param('code'))
    const agents = install && deps.agents?.get(install.backend)
    if (!install || !agents || !deps.agentBin) return c.text('This install code is used or has expired. Make a new one in nuthatch.\n', 404)
    const facts = { install, settings: agents.settings, ca: agents.ca(), sums: binaries(deps.agentBin) }
    deps.store.audit('', install.backend, 'agent install fetched', `${install.host} from ${address(c)}`)
    agents.noteFetched(install.host)
    return c.text(install.os === 'linux' ? linuxScript(facts) : windowsScript(facts), 200, { 'Cache-Control': 'no-store' })
  })

  app.get('/agent/bin/:file', async (c) => {
    const file = c.req.param('file')
    if (!deps.agentBin || !binaries(deps.agentBin).has(file)) return c.text('not found\n', 404)
    const path = join(deps.agentBin, file)
    const { size } = await stat(path)
    const data = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
    return c.body(data, 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'no-cache' })
  })

  // The interface's files hold nothing secret and are served to anyone,
  // so that the login page can load. A path that is no file is the
  // interface's own (its router's), and gets index.html.
  const root = deps.webRoot
  if (root !== undefined) {
    app.get('*', async (c) => {
      const wanted = normalize(join(root, decodeURIComponent(c.req.path)))
      const inside = wanted === root || wanted.startsWith(root.endsWith(sep) ? root : root + sep)
      for (const file of inside && extname(wanted) !== '' ? [wanted, join(root, 'index.html')] : [join(root, 'index.html')]) {
        try {
          const data = await readFile(file)
          const hashed = file.includes(`${sep}assets${sep}`)
          return c.body(new Uint8Array(data), 200, {
            'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          })
        } catch {
          // Not there: the next one.
        }
      }
      return c.text('not found\n', 404)
    })
  }
  return app
}

/** What nuthatch's own listener for hosts answers: the install script and
 * the binaries, and nothing else of the app. */
export function hostsOnly(fetch: (request: Request, env?: unknown) => Response | Promise<Response>) {
  return (request: Request, env?: unknown): Response | Promise<Response> => {
    const { pathname } = new URL(request.url)
    const wanted = (request.method === 'GET' || request.method === 'HEAD') && /^\/agent\/(install|bin)\/[A-Za-z0-9._-]+$/.test(pathname)
    return wanted ? fetch(request, env) : new Response('not found\n', { status: 404 })
  }
}
