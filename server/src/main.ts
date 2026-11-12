// nuthatch: a web interface for monitoring engines that answer
// Livestatus, such as checkd and Naemon.
//
// This server is what the browser talks to. It knows who is logged in and
// what they may see and do, asks the engines over Livestatus, sends them
// commands, tells the browser when something changed, and serves the
// interface's files.

import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { parse } from 'smol-toml'
import { VERSION, buildApp, userName } from './app.ts'
import { Htpasswd, Limiter } from './auth.ts'
import { type Backend, LivestatusBackend } from './backend.ts'
import { Events } from './events.ts'
import { RolesConfig } from './policy.ts'
import { Store } from './store.ts'

const USAGE = 'usage: nuthatch <config file>\n\nSee README.md for the config file.'
const KEYS = ['listen', 'web_root', 'store', 'htpasswd', 'dev_user', 'behind_proxy', 'roles', 'backend']

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

  const listen = text(config, 'listen') ?? '127.0.0.1:8080'
  const at = listen.lastIndexOf(':')
  const hostname = listen.slice(0, at).replace(/^\[|\]$/g, '')
  const port = Number(listen.slice(at + 1))
  if (at < 0 || isIP(hostname) === 0 || !Number.isInteger(port)) fail(`listen: '${listen}' is not address:port`)
  const local = hostname === '::1' || hostname.startsWith('127.')
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
  for (const entry of Array.isArray(config.backend) ? (config.backend as Record<string, unknown>[]) : []) {
    const { name, livestatus } = entry
    if (typeof name !== 'string' || name === '' || backends.some((b) => b.name === name)) fail(`${path}: each backend needs a name of its own`)
    if (typeof livestatus !== 'string') fail(`${path}: backend ${name} needs livestatus = "unix:<socket>"`)
    try {
      backends.push(new LivestatusBackend(name, livestatus))
    } catch (err) {
      fail(`${path}: backend ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (backends.length === 0) fail(`${path}: no [[backend]]`)

  let roles: RolesConfig
  try {
    roles = new RolesConfig((config.roles ?? {}) as Record<string, unknown>)
  } catch (err) {
    fail(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const storePath = text(config, 'store') ?? fail(`${path}: give store, the file nuthatch keeps sessions and its audit log in`)
  const webRoot = text(config, 'web_root')

  const app = buildApp({
    backends,
    store: new Store(storePath),
    events: new Events(backends),
    roles,
    limiter: new Limiter(),
    htpasswd,
    devUser,
    cookieSecure: behindProxy,
    webRoot: webRoot === undefined ? undefined : resolve(webRoot),
  })
  const server = serve({ fetch: app.fetch, hostname, port }, () => {
    console.error(`nuthatch ${VERSION} listening at http://${listen}`)
  })
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
