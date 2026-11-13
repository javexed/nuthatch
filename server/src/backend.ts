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
  /**
   * Comes back when a state changed (`state`) or a check's result came in
   * (`check`), or after `ms`: `woken` or `quiet`. `unsupported` at once
   * from an engine that does not wait. Absent where nothing can be waited
   * for.
   */
  wait?(trigger: 'state' | 'check', ms: number): Promise<Waited>
}

export type Waited = 'woken' | 'quiet' | 'unsupported'

/** How long the question of whether an engine waits takes one that does. */
const WAIT_PROBE = 300

const PROBE_EVERY = 60_000

export class LivestatusBackend implements Backend {
  readonly name: string
  private readonly path: string
  private probed: { answer: boolean; at: number } | null = null
  private waits: { answer: boolean; at: number } | null = null

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

  /**
   * Livestatus can hold an answer back until something happens
   * (`WaitTrigger`, `WaitTimeout`). Whether this engine does is seen by
   * waiting for what never happens while it runs: one that answers
   * before the time is up does not wait.
   */
  private async canWait(): Promise<boolean> {
    if (this.waits && Date.now() - this.waits.at < PROBE_EVERY) return this.waits.answer
    const started = Date.now()
    await this.query(`GET status\nColumns: program_start\nWaitTrigger: program\nWaitTimeout: ${WAIT_PROBE}`)
    const answer = Date.now() - started >= WAIT_PROBE - 50
    this.waits = { answer, at: Date.now() }
    return answer
  }

  async wait(trigger: 'state' | 'check', ms: number): Promise<Waited> {
    if (!(await this.canWait())) return 'unsupported'
    const started = Date.now()
    await this.query(`GET status\nColumns: program_start\nWaitTrigger: ${trigger}\nWaitTimeout: ${Math.round(ms)}`)
    return Date.now() - started < ms - 50 ? 'woken' : 'quiet'
  }

  async enforcesAuth(): Promise<boolean> {
    if (this.probed && Date.now() - this.probed.at < PROBE_EVERY) return this.probed.answer
    const answer = await this.probe()
    this.probed = { answer, at: Date.now() }
    return answer
  }
}
