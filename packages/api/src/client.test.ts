import { describe, expect, it } from 'vitest'
import { ApiError, Client, parseEvents } from './client.ts'

function server(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { path: string; init: RequestInit }[] = []
  const fake = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    calls.push({ path, init })
    const answer = answers[`${init.method ?? 'GET'} ${path}`] ?? { status: 404, body: { error: 'no such thing' } }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }) as typeof fetch
  return { fake, calls }
}

describe('the client', () => {
  it('sends the CSRF value of the session with what changes something', async () => {
    const { fake, calls } = server({
      'POST /api/v1/login': { body: { user: 'ann', csrf: 'abc' } },
      'POST /api/v1/query': { body: { rows: [{ name: 'web1', backend: 'a' }], total: null, errors: {} } },
    })
    const client = new Client({ fetch: fake })
    await client.login('ann', 'secret')
    const answer = await client.query({ table: 'hosts', columns: ['name'] })
    expect(answer.rows[0]?.name).toBe('web1')
    expect((calls[1]?.init.headers as Record<string, string>)['X-Nuthatch-CSRF']).toBe('abc')
  })

  it('sends a token instead, and no cookie', async () => {
    const { fake, calls } = server({ 'GET https://site.example.test/api/v1/tokens': { body: [] } })
    await new Client({ fetch: fake, token: 'nh_x', base: 'https://site.example.test/' }).tokens()
    expect(calls[0]?.path).toBe('https://site.example.test/api/v1/tokens')
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer nh_x')
    expect(calls[0]?.init.credentials).toBe('omit')
  })

  it('gives the server\'s reason for a refusal', async () => {
    const { fake } = server({ 'POST /api/v1/command': { status: 403, body: { error: 'this user is read-only' } } })
    const sent = new Client({ fetch: fake }).command({ backend: 'a', command: 'ENABLE_HOST_CHECK', args: ['web1'] })
    await expect(sent).rejects.toEqual(new ApiError(403, 'this user is read-only'))
  })

  it('reads server-sent events in pieces', () => {
    const first = parseEvents('event: changed\ndata: {"backend":"a"}\n\nevent: back')
    expect(first.events).toEqual([{ event: 'changed', data: '{"backend":"a"}' }])
    const second = parseEvents(first.rest + 'end\ndata: {"name":"a","ok":false}\n\n: keep-alive\n\n')
    expect(second.events).toEqual([{ event: 'backend', data: '{"name":"a","ok":false}' }])
    expect(second.rest).toBe('')
  })
})
