// The client of the nuthatch server.
//
// In a browser it relies on the session's cookie and sends the session's
// CSRF value with every request that changes something. Given a token
// (the phone app), it sends that instead and needs neither.

import type { Command, Query, QueryAnswer, ServerEvent, Session, Stats, StatsAnswer, Token } from './types.ts'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface ClientOptions {
  /** Where the server is; the page's own origin when left out. */
  base?: string
  token?: string
  fetch?: typeof fetch
}

/** Reads server-sent events off a stream of text, one at a time. */
export function parseEvents(buffer: string): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = []
  let at: number
  while ((at = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, at)
    buffer = buffer.slice(at + 2)
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') })
  }
  return { events, rest: buffer }
}

export class Client {
  private csrf: string | null = null
  private readonly base: string
  private readonly token?: string
  private readonly fetch: typeof fetch

  constructor(options: ClientOptions = {}) {
    this.base = (options.base ?? '').replace(/\/$/, '')
    this.token = options.token
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private headers(changes: boolean): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    else if (changes && this.csrf) headers['X-Nuthatch-CSRF'] = this.csrf
    return headers
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = this.headers(method !== 'GET')
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const answer = await this.fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: this.token ? 'omit' : 'same-origin',
    })
    const text = await answer.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      // Not JSON: a proxy's error page, most likely.
    }
    if (!answer.ok) {
      const message = (parsed as { error?: string } | null)?.error ?? `the server answered ${answer.status}`
      throw new ApiError(answer.status, message)
    }
    return parsed as T
  }

  async login(user: string, password: string): Promise<void> {
    const made = await this.call<{ csrf: string }>('POST', '/api/v1/login', { user, password })
    this.csrf = made.csrf
  }

  async logout(): Promise<void> {
    await this.call('POST', '/api/v1/logout', {})
    this.csrf = null
  }

  /** Who is logged in. Throws an ApiError with status 401 when nobody is. */
  async session(): Promise<Session> {
    const session = await this.call<Session>('GET', '/api/v1/session')
    this.csrf = session.csrf
    return session
  }

  query<C extends string>(query: Query<C>): Promise<QueryAnswer<C>> {
    return this.call('POST', '/api/v1/query', query)
  }

  stats(stats: Stats): Promise<StatsAnswer> {
    return this.call('POST', '/api/v1/stats', stats)
  }

  command(command: Command): Promise<{ sent: string }> {
    return this.call('POST', '/api/v1/command', { ...command, args: command.args.map(String) })
  }

  tokens(): Promise<Token[]> {
    return this.call('GET', '/api/v1/tokens')
  }

  newToken(name: string): Promise<Token & { token: string }> {
    return this.call('POST', '/api/v1/tokens', { name })
  }

  deleteToken(id: number): Promise<void> {
    return this.call('DELETE', `/api/v1/tokens/${id}`)
  }

  pref<T>(key: string): Promise<T | null> {
    return this.call('GET', `/api/v1/prefs/${encodeURIComponent(key)}`)
  }

  setPref(key: string, value: unknown): Promise<void> {
    return this.call('PUT', `/api/v1/prefs/${encodeURIComponent(key)}`, value)
  }

  /**
   * Listens for the server's events until `signal` aborts, connecting
   * again when the connection breaks. Read with fetch, not EventSource,
   * which cannot send a token.
   */
  async events(onEvent: (event: ServerEvent) => void, signal: AbortSignal): Promise<void> {
    let pause = 1000
    while (!signal.aborted) {
      try {
        const answer = await this.fetch(this.base + '/api/v1/events', {
          headers: this.headers(false),
          credentials: this.token ? 'omit' : 'same-origin',
          signal,
        })
        if (answer.status === 401) throw new ApiError(401, 'log in first')
        if (!answer.ok || !answer.body) throw new Error(`the server answered ${answer.status}`)
        pause = 1000
        // What happened while not connected is not known.
        onEvent({ type: 'changed' })
        const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          const parsed = parseEvents(buffer + value.replace(/\r\n/g, '\n'))
          buffer = parsed.rest
          for (const { event, data } of parsed.events) {
            const body = JSON.parse(data) as Record<string, unknown>
            if (event === 'changed') onEvent({ type: 'changed', backend: body.backend as string | undefined })
            else if (event === 'backend') onEvent({ type: 'backend', name: body.name as string, ok: body.ok as boolean })
          }
        }
      } catch (err) {
        if (signal.aborted || (err instanceof ApiError && err.status === 401)) return
      }
      await new Promise((resolve) => setTimeout(resolve, pause))
      pause = Math.min(pause * 2, 30000)
    }
  }
}
