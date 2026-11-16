// When a page loads its data again: at once when what it shows changes
// (a filter, another page), and for the server's events and the half-minute
// timer without dropping every answer when the server is slow.
//
// - A load asked for by the page supersedes one that runs: its answer is
//   the one kept.
// - A refresh while a load runs is one more load after it, not a load
//   that makes the running one's answer stale: on a server slower than
//   the events, answers still arrive.
// - Events close together are one refresh, at most `wait` after the
//   first: a stream of events does not put it off for ever.

export interface Reloader {
  /** Load now; an older answer still to come is dropped. */
  reload: () => Promise<void>
  /** Load soon, without dropping the answer of the load that runs. */
  refresh: () => void
  /** Something may have changed: one refresh for events close together. */
  poke: () => void
  /** No more loads, and no answer kept. */
  stop: () => void
}

export function reloader<T>(
  load: () => Promise<T>,
  done: (result: { data: T } | { error: unknown }) => void,
  wait = 250,
): Reloader {
  let latest = 0
  let running = 0
  let again = false
  let stopped = false
  let soon: ReturnType<typeof setTimeout> | undefined

  async function reload(): Promise<void> {
    if (stopped) return
    const mine = ++latest
    running++
    try {
      const data = await load()
      if (mine === latest && !stopped) done({ data })
    } catch (error) {
      if (mine === latest && !stopped) done({ error })
    } finally {
      running--
      if (again && running === 0 && !stopped) {
        again = false
        void reload()
      }
    }
  }

  function refresh(): void {
    if (running > 0) again = true
    else void reload()
  }

  function poke(): void {
    soon ??= setTimeout(() => {
      soon = undefined
      refresh()
    }, wait)
  }

  function stop(): void {
    stopped = true
    clearTimeout(soon)
  }

  return { reload, refresh, poke, stop }
}
