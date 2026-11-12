// A site reached through its own nuthatch: for one interface over
// several sites.
//
// The central nuthatch does not talk Livestatus to a far engine, which
// would be without a login and in the clear. It asks the site's nuthatch,
// over HTTPS, with a key the site gave it, and says for which user it
// asks. The site applies its own roles and its own contacts to that user:
// what a user may see and do at a site is decided at the site.
//
// A site with one backend appears under the name the central gives it;
// one with several as `<name>/<the site's name for it>`.

import type { BackendStatus, Role, Session } from '@nuthatch/api'

/** The site's answer was not a success. */
export class RemoteError extends Error {
  readonly status: number
  readonly detail: Record<string, unknown>

  constructor(status: number, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

const NAMES_FOR = 30_000

export class RemoteSite {
  readonly name: string
  private readonly url: string
  private readonly key: string
  private readonly fetch: typeof fetch
  private known: { names: string[]; at: number } | null = null

  constructor(name: string, url: string, key: string, fetcher: typeof fetch = fetch) {
    this.name = name
    this.url = url.replace(/\/+$/, '')
    this.key = key
    this.fetch = fetcher
  }

  private headers(user: string): Record<string, string> {
    return { Authorization: `Peer ${this.key}`, 'X-Nuthatch-User': encodeURIComponent(user), 'Content-Type': 'application/json' }
  }

  /** Asks the site's API as a user. */
  async call<T>(user: string, method: string, path: string, body?: unknown): Promise<T> {
    let answer: Response
    try {
      answer = await this.fetch(this.url + path, {
        method,
        headers: this.headers(user),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(150_000),
      })
    } catch (err) {
      throw new RemoteError(502, `the site cannot be reached: ${err instanceof Error ? err.message : String(err)}`)
    }
    let parsed: unknown = null
    try {
      parsed = await answer.json()
    } catch {
      // Not JSON: a proxy's error page, most likely.
    }
    const detail = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    // The site not knowing this nuthatch is not the user being logged out here.
    if (answer.status === 401) throw new RemoteError(502, "the site does not take this nuthatch's key")
    if (!answer.ok) throw new RemoteError(answer.status, typeof detail.error === 'string' ? detail.error : `the site answered ${answer.status}`, detail)
    return parsed as T
  }

  /** The site's backends by its own names, remembered for half a minute. */
  private async siteNames(user: string): Promise<string[]> {
    if (this.known && Date.now() - this.known.at < NAMES_FOR) return this.known.names
    const session = await this.call<Session>(user, 'GET', '/api/v1/session')
    this.known = { names: session.backends.map((b) => b.name), at: Date.now() }
    return this.known.names
  }

  /** The name here of one of the site's backends. */
  private async here(user: string, siteName: string): Promise<string> {
    return (await this.siteNames(user)).length === 1 ? this.name : `${this.name}/${siteName}`
  }

  /** The site's name for a backend named here, when it is one of this site's. */
  theirs(name: string): string | undefined {
    if (name === this.name) return this.known?.names.length === 1 ? this.known.names[0] : undefined
    return name.startsWith(`${this.name}/`) ? name.slice(this.name.length + 1) : undefined
  }

  owns(name: string): boolean {
    return name === this.name || name.startsWith(`${this.name}/`)
  }

  /** What the site says of itself to this user, with the names used here. */
  async session(user: string): Promise<{ backends: BackendStatus[]; canSubmit: Record<string, boolean>; configBackends: string[]; roles: Role[] }> {
    const session = await this.call<Session>(user, 'GET', '/api/v1/session')
    this.known = { names: session.backends.map((b) => b.name), at: Date.now() }
    const single = session.backends.length === 1
    const here = (name: string) => (single ? this.name : `${this.name}/${name}`)
    return {
      backends: session.backends.map((b) => ({ ...b, name: here(b.name) })),
      canSubmit: Object.fromEntries(Object.entries(session.can_submit_commands).map(([name, may]) => [here(name), may])),
      configBackends: session.config_backends.map(here),
      roles: session.roles,
    }
  }

  /**
   * Passes a query or a stats request on. `names` are the backends meant,
   * by their names here; none means all of the site's. Rows, groups and
   * errors come back under the names used here.
   */
  async ask<T extends { errors: Record<string, string> }>(user: string, path: string, body: Record<string, unknown>, names: string[]): Promise<T> {
    await this.siteNames(user)
    const backends = names.length === 0 ? undefined : names.map((n) => this.theirs(n) ?? n)
    const answer = await this.call<T & { rows?: { backend: string }[]; by_backend?: Record<string, unknown> }>(user, 'POST', path, { ...body, backends })
    const renamed: Record<string, string> = {}
    const name = async (theirs: string) => (renamed[theirs] ??= await this.here(user, theirs))
    for (const row of answer.rows ?? []) row.backend = await name(row.backend)
    if (answer.by_backend) answer.by_backend = Object.fromEntries(await Promise.all(Object.entries(answer.by_backend).map(async ([k, v]) => [await name(k), v] as const)))
    answer.errors = Object.fromEntries(await Promise.all(Object.entries(answer.errors).map(async ([k, v]) => [await name(k), v] as const)))
    return answer
  }

  /** Listens to the site's change events; `onChange` gets a backend's name here. */
  async events(onEvent: (event: string, data: Record<string, unknown>) => void): Promise<never> {
    let pause = 1000
    for (;;) {
      try {
        // Events carry no data, so they are asked for under no user's name.
        const answer = await this.fetch(`${this.url}/api/v1/events`, { headers: this.headers('nuthatch-events') })
        if (!answer.ok || !answer.body) throw new Error(`the site answered ${answer.status}`)
        pause = 1000
        onEvent('backend', { name: this.name, ok: true })
        let buffer = ''
        for await (const chunk of answer.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk.replace(/\r\n/g, '\n')
          let at: number
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, at)
            buffer = buffer.slice(at + 2)
            const event = /^event: *(.*)$/m.exec(block)?.[1]
            const data = /^data: *(.*)$/m.exec(block)?.[1]
            if (event === undefined || data === undefined) continue
            const parsed = JSON.parse(data) as Record<string, unknown>
            const theirs = typeof parsed.backend === 'string' ? parsed.backend : typeof parsed.name === 'string' ? parsed.name : undefined
            const here = theirs === undefined ? this.name : this.known?.names.length === 1 ? this.name : `${this.name}/${theirs}`
            onEvent(event, event === 'backend' ? { ...parsed, name: here } : { backend: here })
          }
        }
      } catch {
        onEvent('backend', { name: this.name, ok: false })
      }
      await new Promise((resolve) => setTimeout(resolve, pause).unref())
      pause = Math.min(pause * 2, 30_000)
    }
  }
}
