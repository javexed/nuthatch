import { describe, expect, it } from 'vitest'
import { Assistant, type Reader } from './assistant.ts'
import { type Model, type Request, type Settings, checkUrl, keyMayGo, listModels, ollamaModel, openaiModel } from './models.ts'
import { Store } from './store.ts'

/** A fetch that answers from a script, and remembers what it was sent. */
function served(...bodies: { status?: number; body: string }[]) {
  const sent: { url: string; init: RequestInit; json: Record<string, unknown> | undefined }[] = []
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, init, json: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined })
    const next = bodies.shift()
    if (!next) throw new TypeError('fetch failed')
    return new Response(next.body, { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetcher, sent }
}

const settings = (s: Partial<Settings>): Settings => ({ service: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen3:8b', effort: 'medium', context: 16_384, key: '', ...s })
const request = (s: Partial<Settings>, messages: Request['messages'] = [{ role: 'user', text: ['Now: x', 'what is down?'] }]): Request => ({
  settings: settings(s),
  system: 'sys',
  tools: [{ name: 'livestatus_query', description: 'reads', parameters: { type: 'object' } }],
  messages,
})

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const signal = () => new AbortController().signal

describe('model service addresses', () => {
  it('takes http and https addresses, with the service’s own when none is given', () => {
    expect(checkUrl('', 'ollama')).toBe('http://127.0.0.1:11434')
    expect(checkUrl(undefined, 'anthropic')).toBe('https://api.anthropic.com')
    expect(checkUrl('https://openrouter.ai/api/v1/', 'openai')).toBe('https://openrouter.ai/api/v1')
    expect(() => checkUrl('file:///etc/passwd', 'openai')).toThrow()
    expect(() => checkUrl('http://user:pw@host:11434', 'ollama')).toThrow()
    expect(() => checkUrl('http://host:11434/?x=1', 'ollama')).toThrow()
    expect(() => checkUrl('not a url', 'ollama')).toThrow()
  })

  it('lets a key go over https, or to this machine or the tailnet only', () => {
    expect(keyMayGo('https://api.openai.com/v1')).toBe(true)
    expect(keyMayGo('http://127.0.0.1:11434')).toBe(true)
    expect(keyMayGo('http://localhost:8080')).toBe(true)
    expect(keyMayGo('http://[::1]:8080')).toBe(true)
    expect(keyMayGo('http://100.64.0.0:11434')).toBe(true)
    expect(keyMayGo('http://gpu.tail1234.ts.net:11434')).toBe(true)
    expect(keyMayGo('http://192.0.2.20:11434')).toBe(false)
    expect(keyMayGo('http://100.128.0.1:11434')).toBe(false)
    expect(keyMayGo('http://example.com')).toBe(false)
  })
})

describe('Ollama', () => {
  it('streams text, gathers tool calls, and sends the context size', async () => {
    const lines = [
      { message: { role: 'assistant', content: '', thinking: 'hm' }, done: false },
      { message: { role: 'assistant', content: 'Looking. ' }, done: false },
      { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', function: { name: 'livestatus_query', arguments: { table: 'hosts', columns: ['name'] } } }] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 30 },
    ]
    const { fetcher, sent } = served({ body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
    const got = await all(ollamaModel(fetcher)(request({}), signal()))
    expect(got).toEqual([
      { kind: 'text', text: 'Looking. ' },
      { kind: 'step', step: { stop: 'tools', text: 'Looking. ', calls: [{ id: 'call_a', name: 'livestatus_query', input: { table: 'hosts', columns: ['name'] } }], input: 120, output: 30 } },
    ])
    expect(sent[0]?.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(sent[0]?.json).toMatchObject({ model: 'qwen3:8b', stream: true, options: { num_ctx: 16_384 }, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Now: x\n\nwhat is down?' }] })
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(sent[0]?.init.redirect).toBe('error')
  })

  it('gives back the tools’ answers, and says what went wrong', async () => {
    const { fetcher, sent } = served({ body: JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' }) }, { status: 404, body: JSON.stringify({ error: "model 'nope' not found" }) })
    await all(
      ollamaModel(fetcher)(
        request({ key: 'secret-key-0001' }, [
          { role: 'user', text: ['q'] },
          { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'livestatus_query', input: { table: 'hosts' } }] },
          { role: 'tool', results: [{ id: 'c1', name: 'livestatus_query', content: '{"rows":[]}', error: false }] },
        ]),
        signal(),
      ),
    )
    expect((sent[0]?.json?.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'livestatus_query', arguments: { table: 'hosts' } } }] },
      { role: 'tool', tool_name: 'livestatus_query', content: '{"rows":[]}' },
    ])
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key-0001')
    await expect(all(ollamaModel(fetcher)(request({ model: 'nope' }), signal()))).rejects.toThrow("the model service answered 404: model 'nope' not found")
    await expect(all(ollamaModel(fetcher)(request({}), signal()))).rejects.toThrow('could not be reached')
  })
})

describe('OpenAI-compatible', () => {
  it('puts together tool calls sent in pieces', async () => {
    const chunks = [
      { choices: [{ delta: { role: 'assistant', content: 'Let me check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'livestatus_query', arguments: '{"table":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"services","columns":["state"]}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } },
    ]
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    const { fetcher, sent } = served({ body })
    const got = await all(openaiModel(fetcher)(request({ service: 'openai', url: 'https://api.example.com/v1', model: 'some-model', key: 'sk-test-000000' }), signal()))
    expect(got).toEqual([
      { kind: 'text', text: 'Let me check.' },
      { kind: 'step', step: { stop: 'tools', text: 'Let me check.', calls: [{ id: 'call_1', name: 'livestatus_query', input: { table: 'services', columns: ['state'] } }], input: 50, output: 12 } },
    ])
    expect(sent[0]?.url).toBe('https://api.example.com/v1/chat/completions')
    expect(sent[0]?.json).toMatchObject({ model: 'some-model', stream: true, tools: [{ type: 'function', function: { name: 'livestatus_query' } }] })
    expect((sent[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-000000')
  })

  it('sends tool answers by call id, and never runs a call cut off', async () => {
    const cut = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'livestatus_query', arguments: '{"tab' } }] }, finish_reason: 'length' }] }]
    const { fetcher, sent } = served({ body: cut.map((c) => `data: ${JSON.stringify(c)}\n`).join('') })
    const got = await all(
      openaiModel(fetcher)(
        request({ service: 'openai', url: 'http://127.0.0.1:8080/v1' }, [
          { role: 'user', text: ['q'] },
          { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'livestatus_query', input: { table: 'hosts' } }] },
          { role: 'tool', results: [{ id: 'c1', name: 'livestatus_query', content: 'no', error: true }] },
        ]),
        signal(),
      ),
    )
    expect(got.at(-1)).toMatchObject({ kind: 'step', step: { stop: 'cut' } })
    expect((sent[0]?.json?.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'livestatus_query', arguments: '{"table":"hosts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'no' },
    ])
  })
})

describe('listing models', () => {
  it('asks each service in its own way', async () => {
    const { fetcher, sent } = served(
      { body: JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'mistral:7b' }] }) },
      { body: JSON.stringify({ data: [{ id: 'gpt-x' }] }) },
      { body: JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }) },
    )
    expect(await listModels('ollama', 'http://127.0.0.1:11434', '', signal(), fetcher)).toEqual(['mistral:7b', 'qwen3:8b'])
    expect(await listModels('openai', 'https://api.example.com/v1', 'sk-000000000', signal(), fetcher)).toEqual(['gpt-x'])
    expect(await listModels('anthropic', 'https://api.anthropic.com', 'sk-ant-00000000', signal(), fetcher)).toEqual(['claude-opus-5-5'])
    expect(sent.map((s) => s.url)).toEqual(['http://127.0.0.1:11434/api/tags', 'https://api.example.com/v1/models', 'https://api.anthropic.com/v1/models?limit=100'])
    expect((sent[2]?.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-00000000')
    expect(await listModels('anthropic', 'https://api.anthropic.com', '', signal(), fetcher)).toEqual([])
    await expect(listModels('openai', 'http://192.0.2.5:8080/v1', 'sk-000000000', signal(), fetcher)).rejects.toThrow('only over https')
  })
})

describe('the assistant’s settings', () => {
  const config = { model: 'claude-opus-5-5', effort: 'medium' as const, users: ['*'] }

  it('keeps a key only for the service and address it was given for', () => {
    const a = new Assistant(new Store(':memory:'), config)
    expect(a.shown()).toEqual({ service: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-opus-5-5', effort: 'medium', context: 16_384, key: false })
    expect(a.ready()).toBe(false)
    a.setSettings({ service: 'anthropic', url: '', model: 'claude-sonnet-5-5', key: 'ant-test-key-000000000' })
    expect(a.ready()).toBe(true)
    // Same service and address, no key given: kept.
    a.setSettings({ service: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-opus-5-5', effort: 'high' })
    expect(a.hasKey()).toBe(true)
    // Another address: the key is not sent there.
    a.setSettings({ service: 'openai', url: 'https://elsewhere.example/v1', model: 'm' })
    expect(a.hasKey()).toBe(false)
    expect(a.ready()).toBe(true)
    // A key over plain http to another machine is refused.
    expect(() => a.setSettings({ service: 'ollama', url: 'http://192.0.2.9:11434', model: 'qwen3:8b', key: 'secret-0000000' })).toThrow('only over https')
    a.setSettings({ service: 'ollama', url: '', model: 'qwen3:8b', context: 32_768 })
    expect(a.shown()).toMatchObject({ service: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen3:8b', context: 32_768, key: false })
    expect(a.ready()).toBe(true)
    expect(() => a.setSettings({ service: 'ollama', model: 'qwen3:8b', context: 100 })).toThrow()
    expect(() => a.setSettings({ service: 'gemini', model: 'x' })).toThrow()
    expect(() => a.setSettings({ service: 'ollama', model: 'has space' })).toThrow()
  })

  it('asks the service set, with its settings', async () => {
    const asked: Request[] = []
    const ollama: Model = async function* (request) {
      asked.push(request)
      yield { kind: 'text', text: 'All fine.' }
      yield { kind: 'step', step: { stop: 'end', text: 'All fine.', calls: [], input: 9, output: 3 } }
    }
    const a = new Assistant(new Store(':memory:'), config, { ollama })
    a.setSettings({ service: 'ollama', url: '', model: 'qwen3:8b' })
    const reader: Reader = { query: async () => ({ rows: [], total: null, errors: {} }), graph: async () => ({ enabled: false, series: [] }) }
    let spent: number[] = []
    const said = await all(a.answer('ann', [{ role: 'user', text: 'ok?' }], undefined, reader, signal(), (...n) => (spent = n)))
    expect(said).toEqual([{ kind: 'text', text: 'All fine.' }, { kind: 'done', steps: 1 }])
    expect(asked[0]?.settings).toMatchObject({ service: 'ollama', model: 'qwen3:8b', context: 16_384 })
    expect(spent).toEqual([1, 9, 3])
  })
})
