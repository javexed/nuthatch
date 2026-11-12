// A backend: one engine, as nuthatch reaches it. Today that is a
// Livestatus socket; a nuthatch at another site, over HTTPS, comes later
// and fits the same interface.

import * as livestatus from './livestatus.ts'
import { secret } from './store.ts'

export interface Backend {
  readonly name: string
  /** A Livestatus request, without the lines that end it. Rows come back. */
  query(request: string): Promise<unknown[][]>
  /** An external command line, `[time] NAME;arguments`. */
  command(line: string): Promise<void>
  /**
   * Whether the engine limits what a query's `AuthUser` sees. Asked of the
   * engine itself and remembered for a minute; an engine that cannot be
   * asked counts as one that does not.
   */
  enforcesAuth(): Promise<boolean>
}

const PROBE_EVERY = 60_000

export class LivestatusBackend implements Backend {
  readonly name: string
  private readonly path: string
  private probed: { answer: boolean; at: number } | null = null

  constructor(name: string, address: string) {
    this.name = name
    this.path = livestatus.socketPath(address)
  }

  query(request: string): Promise<unknown[][]> {
    return livestatus.query(this.path, request)
  }

  command(line: string): Promise<void> {
    return livestatus.command(this.path, line)
  }

  /**
   * Asks for the hosts as a user that cannot exist. An engine that shows
   * such a user any host does not enforce `AuthUser`. One with no hosts at
   * all cannot be told apart, and counts as not enforcing.
   */
  private async probe(): Promise<boolean> {
    try {
      const count = (rows: unknown[][]) => Number(rows[0]?.[0] ?? -1)
      const all = count(await this.query('GET hosts\nStats: state >= 0'))
      const limited = count(await this.query(`GET hosts\nAuthUser: nuthatch-probe-${secret()}\nStats: state >= 0`))
      return all > 0 && limited === 0
    } catch {
      return false
    }
  }

  async enforcesAuth(): Promise<boolean> {
    if (this.probed && Date.now() - this.probed.at < PROBE_EVERY) return this.probed.answer
    const answer = await this.probe()
    this.probed = { answer, at: Date.now() }
    return answer
  }
}
