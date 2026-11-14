// nuthatch: a web interface for monitoring engines that answer
// Livestatus, such as checkd and Naemon.
//
// This server is what the browser talks to. It knows who is logged in and
// what they may see and do, asks the engines over Livestatus, sends them
// commands, tells the browser when something changed, and serves the
// interface's files.

import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { createAdaptorServer, serve } from '@hono/node-server'
import { parse } from 'smol-toml'
import { type Peer, VERSION, buildApp, userName } from './app.ts'
import { Htpasswd, Limiter, tailnetUsers } from './auth.ts'
import { type Backend, LivestatusBackend } from './backend.ts'
import { pluginsDir } from './catalogue.ts'
import { ConfigAdmin } from './configadmin.ts'
import { PathMap } from './nagioscfg.ts'
import { Events } from './events.ts'
import { RolesConfig } from './policy.ts'
import { Graphs } from './graphs.ts'
import { Pusher } from './push.ts'
import { RemoteSite } from './remote.ts'
import { Store } from './store.ts'

const USAGE = 'usage: nuthatch <config file>\n\nSee README.md for the config file.'
const KEYS = ['listen', 'web_root', 'store', 'htpasswd', 'dev_user', 'behind_proxy', 'tailscale', 'notifications', 'graphs', 'roles', 'backend', 'peer', 'app_origins']

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function text(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  if (value !== undefined && typeof value !== 'string') fail(`${key} is a text`)
  return value
}

function main(): void {
  const [path, extra] = process.argv.slice(2)
  if (path === undefined || extra !== undefined) fail(USAGE)
  let config: Record<string, unknown>
  try {
    config = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    fail(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const unknown = Object.keys(config).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) fail(`${path}: '${unknown}' is not a setting`)

  // address:port, or unix:<path> for a socket only its owner may open.
  const listen = text(config, 'listen') ?? '127.0.0.1:8080'
  const socketPath = listen.startsWith('unix:') ? resolve(listen.slice(5)) : undefined
  const at = listen.lastIndexOf(':')
  const hostname = socketPath === undefined ? listen.slice(0, at).replace(/^\[|\]$/g, '') : ''
  const port = Number(listen.slice(at + 1))
  // The kernel keeps no more of a socket's path than this.
  if (socketPath !== undefined && Buffer.byteLength(socketPath) > 107) fail(`listen: the socket's path ${socketPath} is longer than 107 bytes, which a Unix socket cannot be`)
  if (socketPath === undefined && (at < 0 || isIP(hostname) === 0 || !Number.isInteger(port))) fail(`listen: '${listen}' is not address:port or unix:<path>`)
  const local = socketPath !== undefined || hostname === '::1' || hostname.startsWith('127.')
  const behindProxy = config.behind_proxy === true
  if (!local && !behindProxy) {
    fail(
      `listen = ${listen} reaches beyond this machine, and nuthatch speaks plain HTTP: passwords would cross the network in the clear. ` +
        'Listen on 127.0.0.1 behind a proxy that does TLS, and set behind_proxy = true',
    )
  }

  const htpasswdPath = text(config, 'htpasswd')
  const devUser = text(config, 'dev_user')
  let htpasswd: Htpasswd | undefined
  if (htpasswdPath !== undefined && devUser !== undefined) fail('give htpasswd or dev_user, not both')
  if (htpasswdPath !== undefined) {
    try {
      htpasswd = new Htpasswd(htpasswdPath)
    } catch (err) {
      fail(`cannot read ${htpasswdPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const warning of htpasswd.warnings) console.error(`warning: ${warning}`)
  } else if (devUser !== undefined) {
    if (!local || behindProxy || !userName(devUser)) fail("dev_user is for a loopback listen without a proxy only, and must be a user's name")
    console.error(`warning: dev_user = ${devUser}: nobody logs in, everyone is ${devUser}`)
  } else {
    fail('give htpasswd, the file of the users and their passwords')
  }

  const backends: Backend[] = []
  const admins = new Map<string, ConfigAdmin>()
  const pushUrls = new Map<string, string>()
  const remotes: RemoteSite[] = []
  const keyOf = (file: unknown, what: string): string => {
    if (typeof file !== 'string') fail(`${path}: ${what} needs key_file, the file that holds its key`)
    let key: string
    try {
      key = readFileSync(file, 'utf8').trim()
    } catch (err) {
      fail(`${path}: ${what}: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (key.length < 32 || /\s/.test(key)) fail(`${path}: ${what}: a key is one word of at least 32 letters`)
    return key
  }
  for (const entry of Array.isArray(config.backend) ? (config.backend as Record<string, unknown>[]) : []) {
    const { name, livestatus } = entry
    if (typeof name !== 'string' || name === '' || name.includes('/') || backends.some((b) => b.name === name) || remotes.some((r) => r.name === name)) {
      fail(`${path}: each backend needs a name of its own, without '/'`)
    }
    if (typeof entry.nuthatch === 'string') {
      // A site reached through its own nuthatch.
      let url: URL
      try {
        url = new URL(entry.nuthatch)
      } catch {
        fail(`${path}: backend ${name}: nuthatch is the URL of the site's nuthatch`)
      }
      const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) fail(`${path}: backend ${name}: the site's nuthatch is reached over https`)
      remotes.push(new RemoteSite(name, entry.nuthatch, keyOf(entry.key_file, `backend ${name}`)))
      continue
    }
    if (typeof livestatus !== 'string') fail(`${path}: backend ${name} needs livestatus = "unix:<socket>", or nuthatch = "https://..."`)
    try {
      const backend = new LivestatusBackend(name, livestatus)
      backends.push(backend)
      // Where jobs elsewhere reach the engine's HTTP API, to push results.
      if (entry.push_url !== undefined) {
        if (typeof entry.push_url !== 'string' || !/^https?:\/\/[^\s]+$/.test(entry.push_url)) fail(`${path}: backend ${name}: push_url is a URL`)
        pushUrls.set(name, entry.push_url as string)
      }
      // [backend.config]: where its config can be changed.
      if (entry.config !== undefined) {
        const c = entry.config as Record<string, unknown>
        const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
        if (typeof c.dir !== 'string' || typeof c.main !== 'string' || !strings(c.verify)) {
          fail(`${path}: backend ${name}: config needs dir, main and verify = ["program", ..., "{main}"]`)
        }
        if (c.reload !== undefined && !strings(c.reload)) fail(`${path}: backend ${name}: config.reload is a command, as a list`)
        admins.set(
          name,
          new ConfigAdmin(backend, { dir: c.dir, main: c.main, verify: c.verify, reload: c.reload, paths: new PathMap((c.paths ?? {}) as Record<string, string>), plugins: pluginsDir(c.plugins) }),
        )
      }
    } catch (err) {
      fail(`${path}: backend ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (backends.length === 0 && remotes.length === 0) fail(`${path}: no [[backend]]`)

  // Other nuthatches that may ask here for their users.
  const peers: Peer[] = []
  for (const entry of Array.isArray(config.peer) ? (config.peer as Record<string, unknown>[]) : []) {
    if (typeof entry.name !== 'string' || entry.name === '') fail(`${path}: each peer needs a name`)
    const key = keyOf(entry.key_file, `peer ${entry.name}`)
    peers.push({ name: entry.name, keyHash: createHash('sha256').update(key).digest('hex'), readOnly: entry.read_only === true, config: entry.config === true })
  }

  let roles: RolesConfig
  try {
    roles = new RolesConfig((config.roles ?? {}) as Record<string, unknown>)
  } catch (err) {
    fail(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const appOrigins = config.app_origins ?? []
  // Logins by tailnet identity: only behind tailscale serve on this
  // machine, which sets the header and drops a client's.
  let tailscaleUsers: Map<string, string> | undefined
  if (config.tailscale !== undefined) {
    if (!local || !behindProxy) {
      fail('[tailscale] is for a listen on this machine behind tailscale serve: set behind_proxy = true and listen on unix:<path> (best) or 127.0.0.1')
    }
    try {
      tailscaleUsers = tailnetUsers(config.tailscale)
    } catch (err) {
      fail(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
    console.error(`tailnet logins without a password: ${[...tailscaleUsers.values()].join(', ') || 'none'}`)
    if (socketPath === undefined) {
      console.error(
        `warning: [tailscale] with listen = ${listen}: any program on this machine can connect there and name a tailnet login. ` +
          'listen = "unix:<path>" keeps it to this user',
      )
    }
  }

  if (!Array.isArray(appOrigins) || appOrigins.some((o) => typeof o !== 'string' || !/^[a-z]+:\/\/[^/]+$/.test(o))) {
    fail(`${path}: app_origins is a list of origins, such as "capacitor://localhost"`)
  }
  const storePath = text(config, 'store') ?? fail(`${path}: give store, the file nuthatch keeps sessions and its audit log in`)
  const webRoot = text(config, 'web_root')

  const store = new Store(storePath)
  // [notifications]: to browsers, through their push services.
  let pusher: Pusher | undefined
  if (config.notifications !== undefined) {
    const { subject, ...rest } = (typeof config.notifications === 'object' && config.notifications !== null ? config.notifications : {}) as Record<string, unknown>
    if (Object.keys(rest).length > 0) fail(`${path}: [notifications] has no setting ${Object.keys(rest).join(', ')}`)
    if (typeof subject !== 'string' || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
      fail(`${path}: [notifications] needs subject = "mailto:..." or "https://...": whom a push service may reach about this server`)
    }
    pusher = new Pusher(store, subject, backends)
  }

  // [graphs]: a short history of performance data, in a file beside the store.
  let graphs: Graphs | undefined
  if (config.graphs !== undefined) {
    const { days = 7, ...rest } = (typeof config.graphs === 'object' && config.graphs !== null ? config.graphs : {}) as Record<string, unknown>
    if (Object.keys(rest).length > 0) fail(`${path}: [graphs] has no setting ${Object.keys(rest).join(', ')}`)
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 31) fail(`${path}: [graphs] days is a number of days, 1 to 31`)
    graphs = new Graphs(`${storePath}-graphs`, days, backends)
  }

  const app = buildApp({
    backends,
    store,
    pusher,
    graphs,
    events: new Events(backends),
    roles,
    limiter: new Limiter(),
    htpasswd,
    devUser,
    tailscaleUsers,
    cookieSecure: behindProxy,
    webRoot: webRoot === undefined ? undefined : resolve(webRoot),
    config: admins,
    pushUrls,
    remotes,
    peers,
    appOrigins: appOrigins as string[],
  })
  const ready = () => console.error(`nuthatch ${VERSION} listening at ${socketPath === undefined ? `http://${listen}` : listen}`)
  let server: ReturnType<typeof createAdaptorServer>
  if (socketPath === undefined) {
    server = serve({ fetch: app.fetch, hostname, port }, ready)
  } else {
    // A socket left by an earlier run goes; anything else there is kept.
    try {
      if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
    } catch {
      // Not there.
    }
    server = createAdaptorServer({ fetch: app.fetch })
    // Made for the owner alone: whoever may open it could say, through
    // a proxy's headers, who they are.
    const before = process.umask(0o177)
    server.listen(socketPath, () => {
      process.umask(before)
      chmodSync(socketPath, 0o600)
      ready()
    })
  }
  server.on('error', (err) => fail(`cannot listen at ${listen}: ${err.message}`))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close()
      // Open event streams would keep it from ending.
      setTimeout(() => process.exit(0), 200).unref()
    })
  }
}

main()
