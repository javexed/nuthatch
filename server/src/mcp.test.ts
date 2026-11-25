import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { Limiter } from './auth.ts'
import type { Backend } from './backend.ts'
import { Events } from './events.ts'
import { RolesConfig } from './policy.ts'
import { Store } from './store.ts'

/**
 * A site with one engine, where ann sees everything and ops only through
 * AuthUser; root may change the config. MCP is on unless `mcp` says.
 */
function site(mcp: boolean | null = true) {
  const asked: string[] = []
  const commands: string[] = []
  const backend: Backend = {
    name: 'site',
    query: async (request) => {
      asked.push(request)
      if (request.startsWith('GET contactgroups')) return [['admins', ['ann']]]
      if (request.startsWith('GET contacts')) return [[1]]
      return [['web1', 2, 'CRITICAL - down']]
    },
    command: async (line) => {
      commands.push(line)
    },
    enforcesAuth: async () => true,
  }
  const store = new Store(':memory:')
  if (mcp !== null) store.setPref('', 'mcp', JSON.stringify({ on: mcp }))
  const app = buildApp({
    backends: [backend],
    store,
    events: new Events([]),
    roles: new RolesConfig({ authorized_contactgroup_for_all_hosts: ['admins'], authorized_for_all_host_commands: ['ops'], authorized_for_configuration_information: ['ann'], authorized_for_config_edit: ['root'] }),
    limiter: new Limiter(),
    cookieSecure: false,
  })
  const rpc = (token: string, message: unknown, headers: Record<string, string> = {}) =>
    app.request('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(message),
    })
  return { app, store, asked, commands, rpc }
}

describe('MCP', () => {
  it('starts, lists its read-only tools, and reads as the token’s user', async () => {
    const { store, asked, rpc } = site()
    const { token } = store.newToken('ops', 'claude-code', true)

    const init = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    expect(init.status).toBe(200)
    const started = (await init.json()) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string }; instructions: string } }
    expect(started.result.protocolVersion).toBe('2025-06-18')
    expect(started.result.serverInfo.name).toBe('nuthatch')
    expect(started.result.instructions).toContain('change nothing')

    expect((await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)

    const listed = (await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }
    expect(listed.result.tools.map((t) => t.name)).toEqual(['livestatus_query', 'perf_history'])
    expect(listed.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true)

    const called = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'livestatus_query', arguments: { table: 'hosts', columns: ['name', 'state', 'plugin_output'], filters: ['Filter: state > 0'] } } })
    const answer = (await called.json()) as { result: { content: { type: string; text: string }[]; isError: boolean } }
    expect(answer.result.isError).toBe(false)
    expect(JSON.parse(answer.result.content[0]?.text ?? '')).toEqual({ rows: [{ name: 'web1', state: 2, plugin_output: 'CRITICAL - down', backend: 'site' }] })
    // ops is no admin: the engine was asked as ops.
    expect(asked.find((r) => r.startsWith('GET hosts\nColumns: name state plugin_output'))).toContain('AuthUser: ops')
    expect(store.auditTail(5).find((row) => row.action === 'mcp')?.detail).toBe('claude-code: hosts: state > 0')

    // A refusal is the tool's answer, not a protocol error.
    const refused = (await (await rpc(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'livestatus_query', arguments: { table: 'hosts', columns: [] } } })).json()) as { result: { isError: boolean } }
    expect(refused.result.isError).toBe(true)
    const unknown = (await (await rpc(token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'acknowledge' } })).json()) as { error: { code: number } }
    expect(unknown.error.code).toBe(-32602)
    const noMethod = (await (await rpc(token, { jsonrpc: '2.0', id: 6, method: 'resources/list' })).json()) as { error: { code: number } }
    expect(noMethod.error.code).toBe(-32601)
  })

  it('is for API tokens only, not from a web page', async () => {
    const { app, store, rpc } = site()
    const { token } = store.newToken('ops', 'claude-code', true)
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
    expect((await rpc('nh_wrong', ping)).status).toBe(401)
    expect((await rpc(token, ping, { Origin: 'https://evil.example' })).status).toBe(403)
    const { cookie } = store.newSession('ops')
    const bySession = await app.request('/api/v1/mcp', { method: 'POST', headers: { Cookie: `nuthatch_session=${cookie}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ping) })
    expect(bySession.status).toBe(403)
    expect((await app.request('/api/v1/mcp', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405)
  })
})

describe('MCP on and off', () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
  const settings = (app: ReturnType<typeof site>['app'], token: string, on?: boolean) =>
    app.request('/api/v1/mcp/settings', {
      method: on === undefined ? 'GET' : 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(on === undefined ? {} : { body: JSON.stringify({ on }) }),
    })

  it('is off where it was never used, and config_edit turns it on and off', async () => {
    const { app, store, rpc } = site(null)
    const reader = store.newToken('ops', 'claude-code', true).token
    const admin = store.newToken('root', 'script', false).token
    const ops = store.newToken('ops', 'script', false).token

    const refused = await rpc(reader, ping)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'MCP is off on this server' })
    expect(await (await settings(app, admin)).json()).toEqual({ on: false })

    // Not for a user without config_edit, nor for a read-only token.
    expect((await settings(app, ops, true)).status).toBe(403)
    expect((await settings(app, ops)).status).toBe(403)
    expect((await settings(app, store.newToken('root', 'reader', true).token, true)).status).toBe(403)
    expect((await settings(app, admin, 'yes' as unknown as boolean)).status).toBe(400)

    expect(await (await settings(app, admin, true)).json()).toEqual({ on: true })
    expect((await rpc(reader, ping)).status).toBe(200)
    expect(await (await settings(app, admin, false)).json()).toEqual({ on: false })
    expect((await rpc(reader, ping)).status).toBe(403)
    expect(store.auditTail(10).filter((row) => row.action === 'mcp settings').map((row) => `${row.user} ${row.detail}`)).toEqual(['root off', 'root on'])
  })

  it('stays on, after an upgrade, where it was used before the switch', async () => {
    const { app, store, rpc } = site(null)
    store.audit('ops', '', 'mcp', 'claude-code: hosts')
    expect((await rpc(store.newToken('ops', 'claude-code', true).token, ping)).status).toBe(200)
    expect(await (await settings(app, store.newToken('root', 'script', false).token)).json()).toEqual({ on: true })
  })
})

describe('read-only tokens', () => {
  it('read nothing that can carry a secret, whatever their user’s roles', async () => {
    const { app, store, rpc } = site()
    const reader = store.newToken('ann', 'claude-code', true).token
    const full = store.newToken('ann', 'script').token
    const query = (t: string, sent: unknown) =>
      app.request('/api/v1/query', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(sent) })

    // ann has configuration_information: a token that may do everything reads them.
    const secrets = { table: 'services', columns: ['host_name', 'custom_variable_values'] }
    expect((await query(full, secrets)).status).toBe(200)
    expect((await query(full, { table: 'contacts', columns: ['name'] })).status).toBe(200)

    for (const sent of [
      secrets,
      { table: 'services', columns: ['host_name', 'check_command'] },
      { table: 'hosts', columns: ['name'], headers: ['Filter: custom_variable_names >= CHECKD_PASSIVE_TOKEN'] },
      { table: 'log', columns: ['time'], headers: ['Filter: current_contact_email ~ x'] },
      { table: 'contacts', columns: ['name'] },
      { table: 'commands', columns: ['name'] },
    ]) {
      const answer = await query(reader, sent)
      expect(answer.status, JSON.stringify(sent)).toBe(400)
      expect(((await answer.json()) as { error: string }).error).toMatch(/not for a read-only token/)
    }
    // A value that only looks like such a column is fine.
    expect((await query(reader, { table: 'services', columns: ['host_name'], headers: ['Filter: plugin_output ~ email'] })).status).toBe(200)

    // Over MCP too: the tool says so.
    const called = (await (await rpc(reader, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'livestatus_query', arguments: secrets } })).json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect(called.result.isError).toBe(true)
    expect(called.result.content[0]?.text).toMatch(/custom_variable_values is not for a read-only token/)
  })

  it('read the engines, and nothing else', async () => {
    const { app, store, commands } = site()
    const { token } = store.newToken('ops', 'reader', true)
    const full = store.newToken('ops', 'script').token
    const call = (t: string, method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

    expect((await call(token, 'GET', '/api/v1/session')).status).toBe(200)
    expect((await call(token, 'POST', '/api/v1/query', { table: 'hosts', columns: ['name'] })).status).toBe(200)

    // ops may acknowledge with a token that may do everything, not with this one.
    const ack = { backend: 'site', command: 'ACKNOWLEDGE_HOST_PROBLEM', args: { host: 'web1', comment: 'x' } }
    expect((await call(token, 'POST', '/api/v1/command', ack)).status).toBe(403)
    expect(commands).toEqual([])
    expect((await call(full, 'POST', '/api/v1/command', ack)).status).not.toBe(403)

    for (const [method, path] of [
      ['GET', '/api/v1/passive'],
      ['GET', '/api/v1/tokens'],
      ['GET', '/api/v1/audit'],
      ['GET', '/api/v1/dashboards'],
      ['PUT', '/api/v1/prefs/theme'],
    ] as const) {
      expect((await call(token, method, path, method === 'PUT' ? { value: 'x' } : undefined)).status, `${method} ${path}`).toBe(403)
    }
    expect(store.tokens('ops').map((t) => [t.name, t.read_only])).toEqual([
      ['reader', true],
      ['script', false],
    ])
  })
})
