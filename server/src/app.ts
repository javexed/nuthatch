// The HTTP side: who a request is from, and the routes.

import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { Role, Session as SessionAnswer } from '@nuthatch/api'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import type { Htpasswd, Limiter } from './auth.ts'
import type { Backend } from './backend.ts'
import { COMMAND_NAMES, type Target, checkCommand, isService } from './commands.ts'
import type { Events } from './events.ts'
import { Refused, type Roles, type RolesConfig, TABLES } from './policy.ts'
import { Forbidden, rows, stats } from './query.ts'
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
  /** Mark the session's cookie `Secure`: a proxy in front does TLS. */
  cookieSecure: boolean
  /** The built interface. */
  webRoot?: string
}

/** Who a request is from. */
interface Identity {
  user: string
  /** The session's cookie, when that is how they logged in. */
  cookie?: string
  csrf?: string
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

  app.onError((err, c) => {
    if (err instanceof Forbidden) return c.json({ error: err.message }, 403)
    if (err instanceof Refused) return c.json({ error: err.message }, 400)
    if (err instanceof SyntaxError) return c.json({ error: 'the body is not JSON' }, 400)
    console.error(err)
    return c.json({ error: 'nuthatch failed on this request; see its log' }, 500)
  })

  async function body(c: Context): Promise<Record<string, unknown>> {
    const parsed: unknown = await c.req.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Refused('the body is a JSON object')
    return parsed as Record<string, unknown>
  }

  // Before anyone is known.
  app.post('/api/v1/login', async (c) => {
    if (!deps.htpasswd) return c.json({ error: 'nobody logs in here: dev_user is set' }, 400)
    const { user, password } = await body(c)
    const address = getConnInfo(c).remote.address ?? 'unknown'
    const keys = [`user:${String(user)}`, `addr:${address}`]
    if (deps.limiter.blocked(keys)) return c.json({ error: 'too many failed logins; wait five minutes' }, 429)
    if (!userName(user) || typeof password !== 'string' || !(await deps.htpasswd.check(user, password))) {
      deps.limiter.failed(keys)
      deps.store.audit(String(user).slice(0, 128), '', 'login failed', address)
      return c.json({ error: 'wrong user or password' }, 401)
    }
    deps.limiter.succeeded(keys[0] ?? '')
    const { cookie, session } = deps.store.newSession(user)
    deps.store.audit(user, '', 'login', address)
    c.header('Set-Cookie', `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${deps.cookieSecure ? '; Secure' : ''}`)
    return c.json({ user: session.user, csrf: session.csrf })
  })

  // Finds out who a request is from: an API token, a session's cookie, or
  // the dev user. A request that changes something and comes with a cookie
  // must also carry the session's CSRF value in a header, which a page of
  // another site cannot read or send.
  app.use('/api/*', async (c, next) => {
    let identity: Identity | undefined
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const cookie = getCookie(c, COOKIE)
    if (bearer !== undefined) {
      const user = deps.store.tokenUser(bearer.trim())
      if (user !== null) identity = { user }
    } else if (cookie !== undefined) {
      const session = deps.store.session(cookie)
      if (session) identity = { user: session.user, cookie, csrf: session.csrf }
    } else if (deps.devUser !== undefined) {
      identity = { user: deps.devUser }
    }
    if (!identity) return c.json({ error: 'log in first' }, 401)
    const changes = c.req.method !== 'GET' && c.req.method !== 'HEAD'
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
    const backends = await Promise.all(
      deps.backends.map(async (backend) => {
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
    const answer: SessionAnswer = {
      user: identity.user,
      roles: [...roles] as Role[],
      can_submit_commands: canSubmit,
      csrf: identity.csrf ?? null,
      version: VERSION,
      commands: COMMAND_NAMES,
      tables: TABLES,
      backends,
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

  app.post('/api/v1/query', async (c) => {
    const { user } = c.get('identity')
    return c.json(await rows(deps.backends, user, (await who(user)).roles, await body(c)))
  })

  app.post('/api/v1/stats', async (c) => {
    const { user } = c.get('identity')
    return c.json(await stats(deps.backends, user, (await who(user)).roles, await body(c)))
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

  app.post('/api/v1/command', async (c) => {
    const { user } = c.get('identity')
    const sent = await body(c)
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
    deps.store.audit(user, backend.name, 'command', checked.line)
    return c.json({ sent: checked.line })
  })

  app.get('/api/v1/audit', async (c) => {
    if (!(await who(c.get('identity').user)).roles.has('system_information')) {
      return c.json({ error: 'the audit log needs the role system_information' }, 403)
    }
    return c.json(deps.store.auditTail(500))
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

  app.all('/api/*', (c) => c.json({ error: 'no such thing' }, 404))

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
