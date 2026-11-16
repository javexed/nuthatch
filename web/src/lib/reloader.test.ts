import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloader } from './reloader.ts'

/** A load that answers when told to, with the number of the load. */
function slowServer() {
  const pending: (() => void)[] = []
  let calls = 0
  const load = () =>
    new Promise<number>((resolve) => {
      const n = ++calls
      pending.push(() => resolve(n))
    })
  return { load, pending, calls: () => calls }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('loading again', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  it('keeps answers coming from a server slower than its events', async () => {
    const server = slowServer()
    const seen: number[] = []
    const loads = reloader(server.load, (r) => 'data' in r && seen.push(r.data))
    void loads.reload()
    // Refreshes while the first load runs are one more load after it.
    for (let i = 0; i < 5; i++) loads.refresh()
    expect(server.calls()).toBe(1)
    server.pending.shift()?.()
    await flush()
    expect(seen).toEqual([1])
    expect(server.calls()).toBe(2)
    server.pending.shift()?.()
    await flush()
    expect(seen).toEqual([1, 2])
    expect(server.calls()).toBe(2)
  })

  it('drops the answer of a load the page has superseded', async () => {
    const server = slowServer()
    const seen: number[] = []
    const loads = reloader(server.load, (r) => 'data' in r && seen.push(r.data))
    void loads.reload()
    void loads.reload()
    server.pending.shift()?.()
    server.pending.shift()?.()
    await flush()
    expect(seen).toEqual([2])
  })

  it('does not put a refresh off for ever under a stream of events', async () => {
    const server = slowServer()
    const loads = reloader(server.load, () => {}, 250)
    // An event every 100 ms for a second: a refresh at 250 ms, not after the last.
    for (let t = 0; t < 1000; t += 100) {
      loads.poke()
      vi.advanceTimersByTime(100)
    }
    expect(server.calls()).toBeGreaterThanOrEqual(1)
  })

  it('loads nothing more once stopped', async () => {
    const server = slowServer()
    const seen: number[] = []
    const loads = reloader(server.load, (r) => 'data' in r && seen.push(r.data))
    void loads.reload()
    loads.refresh()
    loads.stop()
    server.pending.shift()?.()
    await flush()
    loads.poke()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
    expect(server.calls()).toBe(1)
  })
})
