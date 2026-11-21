import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { Limiter } from './auth.ts'
import type { Backend } from './backend.ts'
import { Events } from './events.ts'
import { RolesConfig } from './policy.ts'
import { Store } from './store.ts'

/** A site with one engine, where ann sees everything and ops only through AuthUser. */
function site() {
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
  const app = buildApp({
    backends: [backend],
    store,
    events: new Events([]),
    roles: new RolesConfig({ authorized_contactgroup_for_all_hosts: ['admins'], authorized_for_all_host_commands: ['ops'] }),
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

describe('read-only tokens', () => {
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
