import type { QueryAnswer } from '@nuthatch/api'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { Assistant, type Reader, conversation, describe as describeTool, fit, run } from './assistant.ts'
import { type Send, type Streamed, anthropicModel } from './models.ts'
import { Limiter } from './auth.ts'
import type { Backend } from './backend.ts'
import { Events } from './events.ts'
import { RolesConfig } from './policy.ts'
import { Forbidden } from './query.ts'
import { Store } from './store.ts'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

/** A model that answers from a script, and remembers what it was sent. */
function scripted(...replies: { content: Block[]; stop: string }[]): Send & { sent: { key: string; params: Record<string, unknown> }[] } {
  const sent: { key: string; params: Record<string, unknown> }[] = []
  const send = ((key: string, params: Parameters<Send>[1]) => {
    sent.push({ key, params: structuredClone(params) as unknown as Record<string, unknown> })
    const reply = replies.shift()
    if (!reply) throw new Error('the script ran out')
    const message = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: reply.content,
      stop_reason: reply.stop,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    }
    const events = reply.content.flatMap((b, index) => (b.type === 'text' ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }] : []))
    const streamed: Streamed = {
      async *[Symbol.asyncIterator]() {
        yield* events as never[]
      },
      finalMessage: async () => message as never,
    }
    return streamed
  }) as unknown as Send & { sent: typeof sent }
  send.sent = sent
  return send
}

const reader = (answer: Partial<QueryAnswer> = {}): Reader & { asked: Record<string, unknown>[] } => {
  const asked: Record<string, unknown>[] = []
  return {
    asked,
    query: async (sent) => {
      asked.push(sent)
      return { rows: [], total: null, errors: {}, ...answer }
    },
    graph: async () => ({ enabled: true, series: [{ label: 'load1', unit: '', points: [[1, 0.5], [2, 1.5]] }] }),
  }
}

async function all<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of gen) out.push(x)
  return out
}

describe('the assistant', () => {
  it('takes a conversation that alternates and ends with the user, and adds the page and the time', () => {
    const at = new Date('2026-11-17T10:00:00Z')
    const messages = conversation([{ role: 'user', text: 'why?' }], { backend: 'site', host: 'web1', service: 'http' }, at)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      role: 'user',
      text: ['The page open is the service "http" on host "web1" (backend site). Now: 2026-11-17T10:00:00.000Z (1794909600).', 'why?'],
    })
    expect(() => conversation([], undefined)).toThrow()
    expect(() => conversation([{ role: 'assistant', text: 'hi' }], undefined)).toThrow()
    expect(() => conversation([{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }], undefined)).toThrow()
    expect(() => conversation([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], undefined)).toThrow()
    expect(() => conversation([{ role: 'user', text: ' ' }], undefined)).toThrow()
    expect(() => conversation([{ role: 'user', text: 'a' }], { backend: 'site', host: 'web1\nFilter: x' })).toThrow()
  })

  it('runs its tools through the reader, and gives refusals back as errors', async () => {
    const r = reader({ rows: [{ name: 'web1', state: 1, backend: 'site' }] })
    const ok = await run('t1', 'livestatus_query', { table: 'hosts', columns: ['name', 'state'], filters: ['Filter: state > 0'] }, r)
    expect(ok.error).toBe(false)
    expect(JSON.parse(ok.content as string)).toEqual({ rows: [{ name: 'web1', state: 1, backend: 'site' }] })
    expect(r.asked[0]).toEqual({ table: 'hosts', columns: ['name', 'state'], headers: ['Filter: state > 0'], sort: [], limit: 50 })

    expect((await run('t2', 'livestatus_query', { table: 'hosts', columns: ['name'], limit: 1000 }, r)).error).toBe(true)
    expect((await run('t3', 'livestatus_query', { table: 'hosts', columns: [] }, r)).error).toBe(true)
    expect((await run('t4', 'no_such_tool', {}, r)).error).toBe(true)
    const denied: Reader = { ...r, query: async () => Promise.reject(new Forbidden('the table status needs the role system_information')) }
    const refused = await run('t5', 'livestatus_query', { table: 'status', columns: ['program_version'] }, denied)
    expect(refused).toMatchObject({ error: true, content: 'the table status needs the role system_information' })

    const graph = await run('t6', 'perf_history', { backend: 'site', host: 'web1', hours: 6 }, r)
    expect(JSON.parse(graph.content as string)).toEqual([{ label: 'load1', unit: '', points_kept: 2, min: 0.5, max: 1.5, latest: 1.5, points: [[1, 0.5], [2, 1.5]] }])
    expect((await run('t7', 'perf_history', { backend: 'site', host: 'web1', hours: 1000 }, r)).error).toBe(true)
  })

  it('cuts long answers to size', () => {
    const rows = Array.from({ length: 100 }, (_, n) => ({ name: `host${n}`, plugin_output: 'x'.repeat(2000), backend: 'site' }))
    const text = fit({ rows, total: null, errors: {} })
    expect(text.length).toBeLessThanOrEqual(24_000)
    const parsed = JSON.parse(text) as { rows: { plugin_output: string }[]; dropped: number }
    expect(parsed.rows[0]?.plugin_output.length).toBe(1501)
    expect(parsed.dropped).toBeGreaterThan(0)
    expect(describeTool('livestatus_query', { table: 'services', filters: ['Filter: state > 0', 'Filter: host_name = web1'] })).toBe('services: state > 0, host_name = web1')
  })

  it('asks, looks, and answers, one answer at a time per user', async () => {
    const store = new Store(':memory:')
    const send = scripted(
      { content: [{ type: 'text', text: 'Looking. ' }, { type: 'tool_use', id: 'u1', name: 'livestatus_query', input: { table: 'services', columns: ['description', 'state'] } }], stop: 'tool_use' },
      { content: [{ type: 'text', text: 'http is critical.' }], stop: 'end_turn' },
    )
    const assistant = new Assistant(store, { model: 'claude-opus-5-5', effort: 'medium', users: ['ann'] }, { anthropic: anthropicModel(send) })
    expect(assistant.allows('ann')).toBe(true)
    expect(assistant.allows('bob')).toBe(false)
    const noKey = await all(assistant.answer('ann', [{ role: 'user', text: 'what is wrong?' }], undefined, reader(), new AbortController().signal, () => undefined))
    expect(noKey).toEqual([{ kind: 'error', error: 'no API key is set' }])

    expect(() => assistant.setKey('short')).toThrow()
    assistant.setKey('test-key-not-real-0123456789')
    expect(assistant.hasKey()).toBe(true)
    let spent: number[] = []
    const r = reader({ rows: [{ description: 'http', state: 2, backend: 'site' }] })
    const said = await all(assistant.answer('ann', [{ role: 'user', text: 'what is wrong?' }], undefined, r, new AbortController().signal, (...n) => (spent = n)))
    expect(said).toEqual([
      { kind: 'text', text: 'Looking. ' },
      { kind: 'tool', text: 'services' },
      { kind: 'text', text: 'http is critical.' },
      { kind: 'done', steps: 2 },
    ])
    expect(spent).toEqual([2, 220, 10])
    expect(send.sent[0]?.key).toBe('test-key-not-real-0123456789')
    expect(send.sent[0]?.params).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'medium' }, fallbacks: 'default' })
    // The second request carries the tool's answer.
    const second = send.sent[1]?.params.messages as { role: string; content: unknown }[]
    expect(second[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: JSON.stringify({ rows: [{ description: 'http', state: 2, backend: 'site' }] }) }] })

    assistant.setKey('')
    expect(assistant.hasKey()).toBe(false)

    // A model without the server-side fallback is not asked for it.
    const haiku = scripted({ content: [{ type: 'text', text: 'ok' }], stop: 'end_turn' })
    const small = new Assistant(store, { model: 'claude-haiku-5-5', effort: 'low', users: ['*'] }, { anthropic: anthropicModel(haiku) })
    small.setKey('test-key-not-real-0123456789')
    await all(small.answer('ann', [{ role: 'user', text: 'hi' }], undefined, reader(), new AbortController().signal, () => undefined))
    expect(haiku.sent[0]?.params.fallbacks).toBeUndefined()
    expect(haiku.sent[0]?.params.betas).toBeUndefined()
  })

  it('says when the model declines, and never runs a tool cut off at the limit', async () => {
    const store = new Store(':memory:')
    const send = scripted(
      { content: [], stop: 'refusal' },
      { content: [{ type: 'tool_use', id: 'u1', name: 'livestatus_query', input: { table: 'hosts' } }], stop: 'max_tokens' },
    )
    const assistant = new Assistant(store, { model: 'claude-opus-5-5', effort: 'medium', users: ['*'] }, { anthropic: anthropicModel(send) })
    assistant.setKey('test-key-not-real-0123456789')
    const r = reader()
    expect(await all(assistant.answer('ann', [{ role: 'user', text: 'a' }], undefined, r, new AbortController().signal, () => undefined))).toEqual([{ kind: 'error', error: 'the model declined to answer this' }])
    expect(await all(assistant.answer('ann', [{ role: 'user', text: 'a' }], undefined, r, new AbortController().signal, () => undefined))).toEqual([{ kind: 'error', error: 'the answer was cut off' }])
    expect(r.asked).toEqual([])
  })
})

describe('the assistant over HTTP', () => {
  function site(send: Send) {
    const asked: string[] = []
    const backend: Backend = {
      name: 'site',
      query: async (request) => {
        asked.push(request)
        if (request.startsWith('GET contactgroups')) return [['admins', ['ann']]]
        if (request.startsWith('GET contacts')) return [[1]]
        return [['web1', 0]]
      },
      command: async () => undefined,
      enforcesAuth: async () => true,
    }
    const store = new Store(':memory:')
    const assistant = new Assistant(store, { model: 'claude-opus-5-5', effort: 'medium', users: ['ann', 'ops'] }, { anthropic: anthropicModel(send) })
    const app = buildApp({
      backends: [backend],
      store,
      events: new Events([]),
      roles: new RolesConfig({ authorized_contactgroup_for_all_hosts: ['admins'], authorized_for_config_edit: ['ann', 'boss'] }),
      limiter: new Limiter(),
      cookieSecure: false,
      assistant,
    })
    const as = (user: string) => ({ Authorization: `Bearer ${store.newToken(user, 't').token}`, 'Content-Type': 'application/json' })
    const call = (method: string, path: string, user: string, body?: unknown) => app.request(path, { method, headers: as(user), body: body === undefined ? undefined : JSON.stringify(body) })
    return { asked, store, call }
  }

  it('is offered to whom it is for, and its key set by config_edit only', async () => {
    const { call, store } = site(scripted())
    const state = async (user: string) => ((await (await call('GET', '/api/v1/session', user)).json()) as { assistant?: unknown }).assistant
    expect(await state('ann')).toEqual({ ready: false, key: false, set_key: true })
    expect(await state('ops')).toEqual({ ready: false, key: false, set_key: false })
    expect(await state('boss')).toEqual({ ready: false, key: false, set_key: true })
    expect(await state('bob')).toBeUndefined()

    expect((await call('PUT', '/api/v1/assistant/key', 'ops', { key: 'test-key-not-real-0123456789' })).status).toBe(403)
    expect((await call('PUT', '/api/v1/assistant/key', 'ann', { key: 'test-key-not-real-0123456789' })).status).toBe(200)
    expect(await state('ops')).toEqual({ ready: true, key: true, set_key: false })
    // The key is never sent back.
    expect(JSON.stringify(await (await call('GET', '/api/v1/session', 'ann')).json())).not.toContain('test-key-not-real')
    expect(store.auditTail(5).some((row) => row.action === 'assistant key')).toBe(true)
  })

  it('has its service, address and model set by config_edit only, the key never shown', async () => {
    const { call, store } = site(scripted())
    expect((await call('GET', '/api/v1/assistant/settings', 'ops')).status).toBe(403)
    expect((await call('PUT', '/api/v1/assistant/settings', 'ops', { service: 'ollama', model: 'qwen3:8b' })).status).toBe(403)
    expect((await call('POST', '/api/v1/assistant/models', 'ops', { service: 'ollama' })).status).toBe(403)
    expect(await (await call('GET', '/api/v1/assistant/settings', 'ann')).json()).toMatchObject({ service: 'anthropic', model: 'claude-opus-5-5', key: false })

    const put = await call('PUT', '/api/v1/assistant/settings', 'ann', { service: 'openai', url: 'https://api.example.com/v1', model: 'gpt-x', key: 'test-key-not-real-000' })
    expect(put.status).toBe(200)
    const shown = await put.text()
    expect(shown).not.toContain('test-key-not-real-000')
    expect(JSON.parse(shown)).toMatchObject({ service: 'openai', url: 'https://api.example.com/v1', model: 'gpt-x', key: true })
    const state = async (user: string) => ((await (await call('GET', '/api/v1/session', user)).json()) as { assistant?: unknown }).assistant
    expect(await state('ops')).toEqual({ ready: true, key: true, set_key: false })
    expect(store.auditTail(5).find((row) => row.action === 'assistant settings')?.detail).toBe('openai https://api.example.com/v1 gpt-x, key set')

    expect((await call('PUT', '/api/v1/assistant/settings', 'ann', { service: 'ollama', url: 'http://192.0.2.9:11434', model: 'qwen3:8b', key: 'secret-0000000' })).status).toBe(400)
  })

  it('answers as a stream, reading as the user who asks', async () => {
    const send = scripted(
      { content: [{ type: 'tool_use', id: 'u1', name: 'livestatus_query', input: { table: 'hosts', columns: ['name', 'state'] } }], stop: 'tool_use' },
      { content: [{ type: 'text', text: 'All up.' }], stop: 'end_turn' },
    )
    const { call, asked, store } = site(send)
    await call('PUT', '/api/v1/assistant/key', 'ann', { key: 'test-key-not-real-0123456789' })

    expect((await call('POST', '/api/v1/assistant', 'bob', { turns: [{ role: 'user', text: 'hi' }] })).status).toBe(403)
    expect((await call('POST', '/api/v1/assistant', 'ops', { turns: [] })).status).toBe(400)

    const answer = await call('POST', '/api/v1/assistant', 'ops', { turns: [{ role: 'user', text: 'anything down?' }], about: { backend: 'site', host: 'web1' } })
    expect(answer.status).toBe(200)
    const text = await answer.text()
    expect(text).toContain('event: tool')
    expect(text).toContain('"text":"All up."')
    expect(text).toContain('event: done')
    // ops is no admin: the engine was asked as ops.
    expect(asked.find((r) => r.startsWith('GET hosts\nColumns: name state'))).toContain('AuthUser: ops')
    expect(store.auditTail(5).find((row) => row.action === 'assistant')?.detail).toBe('2 steps, 220 tokens in, 10 out')
  })
})

