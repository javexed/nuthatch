// nuthatch: a web interface for monitoring engines that answer
// Livestatus, such as checkd and Naemon.
//
// This server is what the browser talks to. It knows who is logged in and
// what they may see and do, asks the engines over Livestatus, sends them
// commands, tells the browser when something changed, and serves the
// interface's files.

import { networksOf, ufwGaps } from './reach.ts'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { createAdaptorServer, serve } from '@hono/node-server'
import { parse } from 'smol-toml'
import { type Peer, VERSION, buildApp, hostsOnly, userName } from './app.ts'
import { Htpasswd, Limiter, tailnetUsers } from './auth.ts'
import { Agents, type Pin, pinOf } from './agents.ts'
import { Assistant, DEFAULT_MODEL, EFFORTS, type Effort } from './assistant.ts'
import { HostSetup } from './hostsetup.ts'
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
const KEYS = ['agents', 'listen', 'web_root', 'store', 'htpasswd', 'dev_user', 'behind_proxy', 'tailscale', 'notifications', 'graphs', 'assistant', 'roles', 'backend', 'peer', 'app_origins']

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

/** A table of the config file, with only the settings named: a mistyped
 * key is refused, not ignored. */
function table(what: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} is a table`)
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  if (unknown.length > 0) fail(`${what} has no setting ${unknown.map((k) => `'${k}'`).join(', ')}: its settings are ${keys.join(', ')}`)
  return value as Record<string, unknown>
}

/** true or false, written as such: "true" in quotes is refused. */
function flag(what: string, value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') fail(`${what} is true or false, without quotes`)
  return value === true
}

/** A list of tables, as [[backend]] gives. */
function tables(what: string, value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${what} is a list of tables: write [[${what}]]`)
  return value
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
  const behindProxy = flag('behind_proxy', config.behind_proxy)
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
  const httpUrls = new Map<string, string>()
  const httpTokens = new Map<string, string>()
  const agents = new Map<string, Agents>()
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
  for (const each of tables('backend', config.backend)) {
    const entry = table(`${path}: a [[backend]]`, each, ['name', 'livestatus', 'http_url', 'http_token_file', 'config', 'agents', 'nuthatch', 'key_file'])
    const { name, livestatus } = entry
    if (typeof name !== 'string' || name === '' || name.includes('/') || backends.some((b) => b.name === name) || remotes.some((r) => r.name === name)) {
      fail(`${path}: each backend needs a name of its own, without '/'`)
    }
    if (typeof entry.nuthatch === 'string') {
      // A site reached through its own nuthatch.
      table(`${path}: backend ${name}`, entry, ['name', 'nuthatch', 'key_file'])
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
    if (entry.key_file !== undefined) fail(`${path}: backend ${name}: key_file is for a site reached through its nuthatch`)
    try {
      const backend = new LivestatusBackend(name, livestatus)
      backends.push(backend)
      // Where checkd's HTTP API is reached: by jobs elsewhere, and for /metrics.
      if (entry.http_url !== undefined) {
        if (typeof entry.http_url !== 'string' || !/^https?:\/\/[^\s]+$/.test(entry.http_url)) fail(`${path}: backend ${name}: http_url is a URL`)
        httpUrls.set(name, entry.http_url as string)
      }
      // checkd's CHECKD_HTTP_TOKEN, when it has one: the file holds the token,
      // or a line CHECKD_HTTP_TOKEN=... (checkd's own environment file).
      if (entry.http_token_file !== undefined) {
        if (typeof entry.http_token_file !== 'string') fail(`${path}: backend ${name}: http_token_file is a path`)
        let text = ''
        try {
          text = readFileSync(entry.http_token_file, 'utf8')
        } catch (err) {
          fail(`${path}: backend ${name}: cannot read ${entry.http_token_file}: ${err instanceof Error ? err.message : String(err)}`)
        }
        const token = (/^\s*CHECKD_HTTP_TOKEN\s*=\s*"?([^"\s]+)"?\s*$/m.exec(text)?.[1] ?? text).trim()
        if (!token || /\s/.test(token)) fail(`${path}: backend ${name}: ${entry.http_token_file} holds no token`)
        httpTokens.set(name, token)
      }
      // [backend.config]: where its config can be changed.
      if (entry.config !== undefined) {
        const c = table(`${path}: backend ${name}: config`, entry.config, ['dir', 'main', 'verify', 'reload', 'paths', 'plugins'])
        if (c.paths !== undefined && (typeof c.paths !== 'object' || c.paths === null || Array.isArray(c.paths) || Object.values(c.paths).some((v) => typeof v !== 'string'))) {
          fail(`${path}: backend ${name}: config.paths is a table of the engine's paths and this machine's, such as { "/etc/naemon" = "/srv/naemon" }`)
        }
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
      // [backend.agents]: checkd's agents directory, and how hosts reach the engine.
      if (entry.agents !== undefined) {
        const { dir, engine, ca, server_name } = table(`${path}: backend ${name}: agents`, entry.agents, ['dir', 'engine', 'ca', 'server_name'])
        if (typeof dir !== 'string' || typeof ca !== 'string') fail(`${path}: backend ${name}: agents needs dir (checkd's agents=) and ca (the workers' ca.crt)`)
        if (typeof engine !== 'string' || !(/^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])?:\d{1,5}$/.test(engine) || /^wss?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(engine))) {
          fail(`${path}: backend ${name}: agents.engine is host:port, the engine's worker listener as hosts reach it; :port at the address hosts reach nuthatch at; or wss://host/path through a proxy or tunnel`)
        }
        if (server_name !== undefined && (typeof server_name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(server_name))) fail(`${path}: backend ${name}: agents.server_name is a host name`)
        if (!existsSync(dir) || !existsSync(ca)) console.error(`warning: backend ${name}: agents.dir or agents.ca is not there yet`)
        if (!httpUrls.get(name)) fail(`${path}: backend ${name}: agents need http_url, checkd's HTTP: its /metrics tells when a new agent has connected`)
        const admin = admins.get(name)
        agents.set(
          name,
          new Agents(backend, { dir, engine, ca, serverName: server_name as string | undefined, metrics: httpUrls.get(name), metricsToken: httpTokens.get(name) }, () =>
            admin ? admin.reload() : backend.command(`[${Math.floor(Date.now() / 1000)}] RESTART_PROGRAM`),
          ),
        )
      }
    } catch (err) {
      fail(`${path}: backend ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (backends.length === 0 && remotes.length === 0) fail(`${path}: no [[backend]]`)

  // [agents]: where the agent binaries are, and this nuthatch's address as hosts reach it.
  let agentBin: string | undefined
  let agentBase: string | undefined
  const agentUpdate = false
  // Hosts-only listener: TLS with cert and key, or plain HTTP on loopback
  // for a proxy or tunnel in front (then url is what hosts reach).
  let agentListen: { hostname: string; port: number; addresses: string[]; pin?: Pin; cert?: string; key?: string } | undefined
  if (config.agents !== undefined) {
    const { bin, url, listen: hostsListen, cert, key, addresses, update } = table(`${path}: [agents]`, config.agents, ['bin', 'url', 'listen', 'cert', 'key', 'addresses', 'update'])
    // "auto" waits for signed agent binaries (TODO.md): until then whoever
    // could change the binaries here could change every agent.
    if (update === 'auto') fail(`${path}: [agents] update = "auto" waits for signed agent binaries; leave it out, and press Update on a host`)
    if (update !== undefined && update !== 'off') fail(`${path}: [agents] update is "off"`)
    if (typeof bin !== 'string') fail(`${path}: [agents] bin is the directory of checkd's dist/agent`)
    if (!existsSync(join(bin, 'SHA256SUMS'))) console.error(`warning: [agents] bin: no ${join(bin, 'SHA256SUMS')} yet (checkd's scripts/build-agents.sh)`)
    agentBin = bin
    if (url !== undefined) {
      if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) fail(`${path}: [agents] url is this nuthatch's address, as hosts reach it`)
      agentBase = url.replace(/\/+$/, '')
    }
    if (hostsListen !== undefined) {
      const at = typeof hostsListen === 'string' ? hostsListen.lastIndexOf(':') : -1
      const hostname = typeof hostsListen === 'string' ? hostsListen.slice(0, at).replace(/^\[|\]$/g, '') : ''
      const port = typeof hostsListen === 'string' ? Number(hostsListen.slice(at + 1)) : NaN
      if (at < 0 || isIP(hostname) === 0 || !Number.isInteger(port)) fail(`${path}: [agents] listen is address:port`)
      if ((cert === undefined) !== (key === undefined) || (cert !== undefined && (typeof cert !== 'string' || typeof key !== 'string'))) fail(`${path}: [agents] cert and key go together`)
      if (cert === undefined) {
        // Plain HTTP: only for a proxy or tunnel on this machine.
        if (!['127.0.0.1', '::1'].includes(hostname) || url === undefined) fail(`${path}: [agents] listen without cert is for a proxy or tunnel: listen on 127.0.0.1, and url is the address it gives hosts`)
      }
      if (url !== undefined) {
        if (addresses !== undefined) fail(`${path}: [agents] takes url or addresses, not both`)
      } else if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every((a) => typeof a === 'string' && (isIP(a) !== 0 || /^[A-Za-z0-9.-]+$/.test(a)))) {
        fail(`${path}: [agents] listen needs url, or addresses: this machine's addresses or names as hosts reach it`)
      }
      let pin: Pin | undefined
      if (typeof cert === 'string' && url === undefined) {
        // Hosts reach this listener straight: its certificate is checked by pin.
        try {
          pin = pinOf(readFileSync(cert, 'utf8'))
        } catch (err) {
          fail(`${path}: [agents] cert: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      agentListen = { hostname, port, addresses: (addresses ?? []) as string[], pin, cert: cert as string | undefined, key: key as string | undefined }
    }
  }

  // Other nuthatches that may ask here for their users.
  const peers: Peer[] = []
  for (const each of tables('peer', config.peer)) {
    const entry = table(`${path}: a [[peer]]`, each, ['name', 'key_file', 'read_only', 'config'])
    if (typeof entry.name !== 'string' || entry.name === '') fail(`${path}: each peer needs a name`)
    const key = keyOf(entry.key_file, `peer ${entry.name}`)
    const readOnly = flag(`${path}: peer ${entry.name}: read_only`, entry.read_only)
    const configToo = flag(`${path}: peer ${entry.name}: config`, entry.config)
    peers.push({ name: entry.name, keyHash: createHash('sha256').update(key).digest('hex'), readOnly, config: configToo })
  }

  let roles: RolesConfig
  try {
    roles = new RolesConfig(config.roles === undefined ? {} : table(`${path}: [roles]`, config.roles, Object.keys(config.roles as object)))
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
  // What agents say their hosts are: kept, and the base checks added once.
  const setup = new HostSetup(store, admins)
  for (const [name, each] of agents) each.onInventory = (host, text, received) => setup.take(name, host, text, received)
  // [notifications]: to browsers, through their push services.
  let pusher: Pusher | undefined
  if (config.notifications !== undefined) {
    const { subject } = table(`${path}: [notifications]`, config.notifications, ['subject'])
    if (typeof subject !== 'string' || !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
      fail(`${path}: [notifications] needs subject = "mailto:..." or "https://...": whom a push service may reach about this server`)
    }
    pusher = new Pusher(store, subject, backends)
  }

  // [graphs]: a short history of performance data, in a file beside the store.
  let graphs: Graphs | undefined
  if (config.graphs !== undefined) {
    const { days = 7 } = table(`${path}: [graphs]`, config.graphs, ['days'])
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 31) fail(`${path}: [graphs] days is a number of days, 1 to 31`)
    graphs = new Graphs(`${storePath}-graphs`, days, backends)
  }

  // [assistant]: a chat about what the engines say, by Claude; the API key
  // is set in the interface, by config_edit.
  let assistant: Assistant | undefined
  if (config.assistant !== undefined) {
    const { model = DEFAULT_MODEL, effort = 'medium', users } = table(`${path}: [assistant]`, config.assistant, ['model', 'effort', 'users'])
    if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,99}$/.test(model)) fail(`${path}: [assistant] model is a model's name, such as "${DEFAULT_MODEL}"`)
    if (!EFFORTS.includes(effort as Effort)) fail(`${path}: [assistant] effort is one of ${EFFORTS.join(', ')}`)
    if (!Array.isArray(users) || users.length === 0 || users.some((u) => typeof u !== 'string' || (u !== '*' && !userName(u)))) {
      fail(`${path}: [assistant] users lists who may use it, or "*" for everyone who logs in`)
    }
    assistant = new Assistant(store, { model, effort: effort as Effort, users: users as string[] })
  }

  const app = buildApp({
    backends,
    store,
    pusher,
    graphs,
    assistant,
    events: new Events(backends),
    roles,
    limiter: new Limiter(),
    htpasswd,
    devUser,
    tailscaleUsers,
    cookieSecure: behindProxy,
    webRoot: webRoot === undefined ? undefined : resolve(webRoot),
    config: admins,
    setup,
    httpUrls,
    agents,
    agentBin,
    agentBase,
    agentUpdate,
    agentListen: agentListen?.pin && { port: agentListen.port, addresses: agentListen.addresses, pin: agentListen.pin },
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
  // New agents' tokens: in use once their agent has connected, taken back
  // when never used.
  setInterval(() => {
    for (const each of agents.values()) each.settle().catch((err: unknown) => console.error(`agents: ${err instanceof Error ? err.message : String(err)}`))
  }, 5000).unref()
  // For monitored hosts: the install script and the binaries only.
  let hostsServer: ReturnType<typeof createAdaptorServer> | undefined
  if (agentListen) {
    const { hostname: h, port: p, cert, key, pin } = agentListen
    const where = `${cert ? 'https' : 'http'}://${h.includes(':') ? `[${h}]` : h}:${p}`
    if (cert && key) {
      const tls = () => ({ cert: readFileSync(cert), key: readFileSync(key) })
      const server = serve({ fetch: hostsOnly(app.fetch), hostname: h, port: p, createServer: createHttpsServer, serverOptions: tls() }, () => console.error(`agents: listening at ${where}`))
      hostsServer = server
      // A renewed certificate (Let's Encrypt) is taken up within the hour.
      let seen = readFileSync(cert, 'utf8')
      setInterval(() => {
        try {
          const now = readFileSync(cert, 'utf8')
          if (now === seen) return
          ;(server as unknown as { setSecureContext(o: object): void }).setSecureContext(tls())
          if (pin) Object.assign(pin, pinOf(now))
          seen = now
          console.error('agents: certificate renewed')
        } catch (err) {
          console.error(`agents: cannot read the renewed certificate: ${err instanceof Error ? err.message : String(err)}`)
        }
      }, 3600_000).unref()
    } else {
      hostsServer = serve({ fetch: hostsOnly(app.fetch), hostname: h, port: p }, () => console.error(`agents: listening at ${where}`))
    }
    hostsServer.on('error', (err) => fail(`cannot listen at ${where} for agents: ${err.message}`))
  }
  // This machine's firewall: what it keeps out of the agent ports, said once at the start.
  if (agentListen) {
    const engines = [...agents.values()].map((a) => /^:(\d+)$/.exec(a.settings.engine)?.[1]).filter((p): p is string => p !== undefined).map(Number)
    for (const gap of ufwGaps([agentListen.port, ...new Set(engines)], [...networksOf(agentListen.addresses).values()])) {
      console.error(`agents: ufw keeps ${gap.from || 'everyone'} out of port ${gap.port}; to let it in: ${gap.command}`)
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close()
      hostsServer?.close()
      // Open event streams would keep it from ending.
      setTimeout(() => process.exit(0), 200).unref()
    })
  }
}

main()
