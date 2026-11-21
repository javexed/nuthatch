// The model services the assistant can ask: Anthropic's API, Ollama's own
// API, and services that speak OpenAI's chat completions (OpenAI,
// OpenRouter, vLLM, llama.cpp, LM Studio, LocalAI and others). Each takes
// the conversation in one form and answers in one form, so the assistant's
// loop is the same whichever it asks.
//
// Where it is sent is set by config_edit in the interface. A key is sent
// only over HTTPS, or to this machine or the tailnet, and never after a
// redirect.

import Anthropic from '@anthropic-ai/sdk'
import { Refused } from './policy.ts'

export type Service = 'anthropic' | 'ollama' | 'openai'
export const SERVICES: Service[] = ['anthropic', 'ollama', 'openai']
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Where each service is when no address is given. */
export const DEFAULT_URL: Record<Service, string> = {
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1',
}
/** How many tokens Ollama is told the model may hold, when not set. */
export const DEFAULT_CONTEXT = 16_384
export const CONTEXTS = { least: 2_048, most: 262_144 }

/** What the assistant asks with: set in the interface. */
export interface Settings {
  service: Service
  url: string
  model: string
  /** Anthropic only. */
  effort: Effort
  /** Ollama only: its `num_ctx`. */
  context: number
  /** '' for none. */
  key: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}
export interface Call {
  id: string
  name: string
  input: unknown
}
export interface Result {
  id: string
  name: string
  content: string
  error: boolean
}
export type Message =
  | { role: 'user'; text: string[] }
  /** `raw` is what the service sent, given back as it was where it wants that. */
  | { role: 'assistant'; text: string; calls: Call[]; raw?: unknown }
  | { role: 'tool'; results: Result[] }

/** How one request to the model ended. */
export interface Step {
  /** end: answered; tools: wants its tools run; cut: stopped at the length limit while asking for a tool. */
  stop: 'end' | 'tools' | 'refusal' | 'cut' | 'pause'
  text: string
  calls: Call[]
  raw?: unknown
  input: number
  output: number
}
export type Piece = { kind: 'text'; text: string } | { kind: 'step'; step: Step }
export interface Request {
  settings: Settings
  system: string
  tools: ToolSpec[]
  messages: Message[]
}
/** Sends one request, giving the text as it comes and the step at the end. */
export type Model = (request: Request, signal: AbortSignal) => AsyncIterable<Piece>

/** A model service that answered with an error, or not at all. */
export class ModelError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------- checks

const MODEL = /^[\x21-\x7e]{1,200}$/
const KEY = /^[\x21-\x7e]{8,500}$/

export function checkModel(given: unknown): string {
  if (typeof given !== 'string' || !MODEL.test(given)) throw new Refused("a model is a name, such as claude-opus-5-5 or qwen3:8b")
  return given
}

export function checkKey(given: unknown): string {
  const key = typeof given === 'string' ? given.trim() : ''
  if (key !== '' && !KEY.test(key)) throw new Refused('an API key is one word of 8 to 500 characters')
  return key
}

/** An address of a model service: http or https, no user, query or fragment; '' is the service's own. */
export function checkUrl(given: unknown, service: Service): string {
  if (given === undefined || given === null || (typeof given === 'string' && given.trim() === '')) return DEFAULT_URL[service]
  if (typeof given !== 'string' || given.length > 300) throw new Refused('the address is a URL')
  let url: URL
  try {
    url = new URL(given.trim())
  } catch {
    throw new Refused('the address is a URL, such as http://127.0.0.1:11434')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused('the address starts with http:// or https://')
  if (url.username !== '' || url.password !== '') throw new Refused('the address holds no user or password; a key goes in its own field')
  if (url.search !== '' || url.hash !== '') throw new Refused('the address has no ? or # part')
  return url.href.replace(/\/+$/, '')
}

/** Whether a key may be sent to this address: HTTPS, or this machine, or the tailnet (WireGuard). */
export function keyMayGo(address: string): boolean {
  const url = new URL(address)
  if (url.protocol === 'https:') return true
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host.endsWith('.ts.net') || host.startsWith('fd7a:115c:a1e0:')) return true
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 127 || (a === 100 && b >= 64 && b <= 127)
}

// ---------------------------------------------------------------- Anthropic

type Params = Parameters<Anthropic['beta']['messages']['stream']>[0]
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent

export interface Streamed extends AsyncIterable<StreamEvent> {
  finalMessage(): Promise<BetaMessage>
}
/** Sends one request to Anthropic; tests give their own. */
export type Send = (key: string, params: Params, signal: AbortSignal, url?: string) => Streamed

/** The real Anthropic API, a client per key and address. */
export function anthropicSend(): Send {
  const clients = new Map<string, Anthropic>()
  return (key, params, signal, url = DEFAULT_URL.anthropic) => {
    const id = `${url} ${key}`
    let client = clients.get(id)
    if (!client) {
      clients.clear()
      client = new Anthropic({ apiKey: key, baseURL: url })
      clients.set(id, client)
    }
    return client.beta.messages.stream(params, { signal })
  }
}

/** The models that take Anthropic's server-side fallback after a refusal. */
const FALLBACKS = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/

export function anthropicModel(send: Send = anthropicSend()): Model {
  return async function* ({ settings, system, tools, messages }, signal) {
    const params: Params = {
      model: settings.model,
      max_tokens: 16_000,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as never, eager_input_streaming: true })),
      messages: messages.map(toAnthropic),
      cache_control: { type: 'ephemeral' },
      output_config: { effort: settings.effort },
      ...(FALLBACKS.test(settings.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }
    const stream = send(settings.key, params, signal, settings.url === DEFAULT_URL.anthropic ? undefined : settings.url)
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { kind: 'text', text: event.delta.text }
    }
    const message = await stream.finalMessage()
    const calls: Call[] = message.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []))
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    const u = message.usage
    const stop: Step['stop'] =
      message.stop_reason === 'refusal' ? 'refusal' : message.stop_reason === 'pause_turn' ? 'pause' : calls.length === 0 ? 'end' : message.stop_reason === 'max_tokens' ? 'cut' : 'tools'
    yield {
      kind: 'step',
      step: { stop, text, calls, raw: message.content, input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens },
    }
  }
}

function toAnthropic(m: Message): MessageParam {
  if (m.role === 'user') return { role: 'user', content: m.text.map((text) => ({ type: 'text', text })) }
  if (m.role === 'assistant') {
    if (m.raw !== undefined) return { role: 'assistant', content: m.raw as never }
    return { role: 'assistant', content: [...(m.text ? [{ type: 'text' as const, text: m.text }] : []), ...m.calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input }))] }
  }
  return {
    role: 'user',
    content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content, ...(r.error ? { is_error: true } : {}) })),
  }
}

// ---------------------------------------------------------------- over HTTP

type Fetch = typeof fetch

/** How much one answer may send back. */
const LINE = 1_000_000
const ANSWER = 8_000_000

async function post(fetcher: Fetch, url: string, key: string, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  let res: Response
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, text/event-stream, application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    })
  } catch (err) {
    if (signal.aborted) throw err
    throw new ModelError('the model service could not be reached')
  }
  if (!res.ok || !res.body) throw new ModelError(await said(res), res.status)
  return res.body
}

/** The error a service sent, in one short line. */
async function said(res: Response): Promise<string> {
  let text = ''
  try {
    text = (await res.text()).slice(0, 4000)
    const parsed = JSON.parse(text) as { error?: string | { message?: string } }
    const e = parsed.error
    text = typeof e === 'string' ? e : (e?.message ?? text)
  } catch {
    // Not JSON: the text as it is.
  }
  const line = text.replace(/\s+/g, ' ').trim().slice(0, 200)
  return `the model service answered ${res.status}${line ? `: ${line}` : ''}`
}

/** The lines of a stream, with limits. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > ANSWER) throw new ModelError('the model service sent too much')
    buffer += decoder.decode(chunk, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '')
      buffer = buffer.slice(at + 1)
      if (line.trim() !== '') yield line
    }
    if (buffer.length > LINE) throw new ModelError('the model service sent a line too long')
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') yield buffer
}

function parse(line: string): Record<string, unknown> {
  try {
    const v = JSON.parse(line) as unknown
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>
  } catch {
    // Below.
  }
  throw new ModelError('the model service sent something that is not JSON')
}

/** Arguments as an object; text that is not JSON gives null, which the tool refuses. */
function args(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v.trim() === '') return {}
  try {
    return JSON.parse(v) as unknown
  } catch {
    return null
  }
}

const functions = (tools: ToolSpec[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))

// ---------------------------------------------------------------- Ollama

export function ollamaModel(fetcher: Fetch = fetch): Model {
  return async function* ({ settings, system, tools, messages }, signal) {
    const sent = messages.flatMap((m): Record<string, unknown>[] => {
      if (m.role === 'user') return [{ role: 'user', content: m.text.join('\n\n') }]
      if (m.role === 'assistant') {
        return [{ role: 'assistant', content: m.text, ...(m.calls.length > 0 ? { tool_calls: m.calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.input } })) } : {}) }]
      }
      return m.results.map((r) => ({ role: 'tool', tool_name: r.name, content: r.content }))
    })
    const body = await post(
      fetcher,
      `${settings.url}/api/chat`,
      settings.key,
      { model: settings.model, stream: true, options: { num_ctx: settings.context }, messages: [{ role: 'system', content: system }, ...sent], tools: functions(tools) },
      signal,
    )
    let text = ''
    const calls: Call[] = []
    let reason = ''
    let input = 0
    let output = 0
    for await (const line of lines(body)) {
      const d = parse(line)
      if (typeof d.error === 'string') throw new ModelError(`the model service answered: ${d.error.slice(0, 200)}`)
      const m = (d.message ?? {}) as { content?: unknown; tool_calls?: unknown }
      if (typeof m.content === 'string' && m.content !== '') {
        text += m.content
        yield { kind: 'text', text: m.content }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) {
          calls.push({ id: typeof tc.id === 'string' && tc.id !== '' ? tc.id : `call_${calls.length + 1}`, name: String(tc.function?.name ?? ''), input: args(tc.function?.arguments) })
        }
      }
      if (d.done === true) {
        reason = String(d.done_reason ?? '')
        input = Number(d.prompt_eval_count ?? 0) || 0
        output = Number(d.eval_count ?? 0) || 0
      }
    }
    const stop: Step['stop'] = calls.length === 0 ? 'end' : reason === 'length' ? 'cut' : 'tools'
    yield { kind: 'step', step: { stop, text, calls, input, output } }
  }
}

// ---------------------------------------------------------------- OpenAI-compatible

export function openaiModel(fetcher: Fetch = fetch): Model {
  return async function* ({ settings, system, tools, messages }, signal) {
    const sent = messages.flatMap((m): Record<string, unknown>[] => {
      if (m.role === 'user') return [{ role: 'user', content: m.text.join('\n\n') }]
      if (m.role === 'assistant') {
        return [
          {
            role: 'assistant',
            content: m.text === '' ? null : m.text,
            ...(m.calls.length > 0 ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
          },
        ]
      }
      return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }))
    })
    const body = await post(
      fetcher,
      `${settings.url}/chat/completions`,
      settings.key,
      { model: settings.model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, ...sent], tools: functions(tools) },
      signal,
    )
    let text = ''
    const building: { id: string; name: string; args: string }[] = []
    let reason = ''
    let input = 0
    let output = 0
    for await (const line of lines(body)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break
      const d = parse(data)
      if (d.error !== undefined) {
        const e = d.error as { message?: unknown } | string
        throw new ModelError(`the model service answered: ${String(typeof e === 'string' ? e : (e.message ?? 'an error')).slice(0, 200)}`)
      }
      const usage = d.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined
      if (usage) {
        input = Number(usage.prompt_tokens ?? 0) || 0
        output = Number(usage.completion_tokens ?? 0) || 0
      }
      const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as { delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown } | undefined
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content !== '') {
        text += delta.content
        yield { kind: 'text', text: delta.content }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const [n, tc] of (delta.tool_calls as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]).entries()) {
          const at = typeof tc.index === 'number' ? tc.index : n
          if (at < 0 || at > 63) continue
          const call = (building[at] ??= { id: '', name: '', args: '' })
          if (typeof tc.id === 'string' && tc.id !== '') call.id = tc.id
          if (typeof tc.function?.name === 'string') call.name += tc.function.name
          if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments
          else if (tc.function?.arguments !== undefined) call.args = JSON.stringify(tc.function.arguments)
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') reason = choice.finish_reason
    }
    const calls: Call[] = building.flatMap((c, n) => (c ? [{ id: c.id || `call_${n + 1}`, name: c.name, input: args(c.args) }] : []))
    const stop: Step['stop'] = reason === 'content_filter' ? 'refusal' : calls.length === 0 ? 'end' : reason === 'length' ? 'cut' : 'tools'
    yield { kind: 'step', step: { stop, text, calls, input, output } }
  }
}

// ---------------------------------------------------------------- the models a service offers

/** The names of the models a service offers, for the settings form. */
export async function listModels(service: Service, url: string, key: string, signal: AbortSignal, fetcher: Fetch = fetch): Promise<string[]> {
  const [path, headers, pick] =
    service === 'ollama'
      ? ['/api/tags', key ? { Authorization: `Bearer ${key}` } : {}, (d: Record<string, unknown>) => (d.models as { name?: unknown }[] | undefined)?.map((m) => m.name)]
      : service === 'openai'
        ? ['/models', key ? { Authorization: `Bearer ${key}` } : {}, (d: Record<string, unknown>) => (d.data as { id?: unknown }[] | undefined)?.map((m) => m.id)]
        : ['/v1/models?limit=100', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, (d: Record<string, unknown>) => (d.data as { id?: unknown }[] | undefined)?.map((m) => m.id)]
  if (service === 'anthropic' && key === '') return []
  if (key !== '' && !keyMayGo(url)) throw new Refused('a key is sent only over https, or to this machine or the tailnet')
  let res: Response
  try {
    res = await fetcher(url + path, { headers: headers as Record<string, string>, signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]), redirect: 'error' })
  } catch {
    throw new ModelError('the model service could not be reached')
  }
  if (!res.ok) throw new ModelError(await said(res), res.status)
  const text = await res.text()
  if (text.length > ANSWER) throw new ModelError('the model service sent too much')
  const names = pick(parse(text)) ?? []
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && MODEL.test(n)))].sort().slice(0, 500)
}
