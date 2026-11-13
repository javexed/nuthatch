// Keeping what a page shows current: loaded when the page opens, again
// when the server says something changed, and every half minute for what
// changes without an event (outputs, times of checks).

import { defineStore } from 'pinia'
import { type Ref, type WatchSource, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ApiError } from '@nuthatch/api'
import { api } from './session'

/** How long a check that was asked for is waited for. */
const AWAIT_CHECK = 45_000
const checkKey = (t: { backend: string; host: string; service?: string }) => JSON.stringify([t.backend, t.host, t.service ?? null])

export const useLive = defineStore('live', () => {
  /** Goes up whenever something may have changed. */
  const version = ref(0)
  let stop: AbortController | null = null

  /** Whether the stream of events is open; null before it was tried. */
  const connected = ref<boolean | null>(null)
  /** When it broke: what the pages show is from then. */
  const lostAt = ref(0)

  function start(): void {
    if (stop) return
    stop = new AbortController()
    void api.events((event) => {
      if (event.type === 'connected') connected.value = true
      else if (event.type === 'disconnected') {
        if (connected.value !== false) lostAt.value = Date.now()
        connected.value = false
      } else version.value++
    }, stop.signal)
  }

  function end(): void {
    stop?.abort()
    stop = null
    connected.value = null
  }

  // Checks that were asked for and whose results are waited for: a row
  // shows it, and the pages ask again every second until the result is
  // there, since a result that changes no state sends no event.
  const awaited = reactive(new Map<string, { before: number; until: number }>())
  let asking: ReturnType<typeof setInterval> | undefined

  function expectCheck(target: { backend: string; host: string; service?: string }, lastCheck: number): void {
    awaited.set(checkKey(target), { before: lastCheck, until: Date.now() + AWAIT_CHECK })
    asking ??= setInterval(() => {
      for (const [key, wait] of awaited) if (Date.now() > wait.until) awaited.delete(key)
      if (awaited.size === 0) {
        clearInterval(asking)
        asking = undefined
      } else version.value++
    }, 1000)
  }

  /** Whether a check asked for is still out, given the last check the page knows of. */
  function checking(target: { backend: string; host: string; service?: string }, lastCheck: number): boolean {
    const wait = awaited.get(checkKey(target))
    return wait !== undefined && lastCheck <= wait.before
  }

  /** A page saw the result: no more waiting for it. */
  function arrived(target: { backend: string; host: string; service?: string }, lastCheck: number): boolean {
    const key = checkKey(target)
    const wait = awaited.get(key)
    if (wait === undefined || lastCheck <= wait.before) return false
    awaited.delete(key)
    return true
  }

  /** Something was just sent to an engine, which takes a moment to act. */
  function nudge(): void {
    for (const wait of [700, 2500]) setTimeout(() => version.value++, wait)
  }

  return { version, connected, lostAt, awaited, start, end, nudge, expectCheck, checking, arrived }
})

export interface Loaded<T> {
  data: Ref<T | null>
  error: Ref<string>
  loading: Ref<boolean>
  reload: () => Promise<void>
}

/**
 * Loads with `load`, and again when `sources` change and, unless `live`
 * is off, when the server says something changed and every half minute.
 */
export function useLoader<T>(load: () => Promise<T>, sources: WatchSource[] = [], options: { live?: boolean } = {}): Loaded<T> {
  const follow = options.live !== false
  const live = useLive()
  const data = ref<T | null>(null) as Ref<T | null>
  const error = ref('')
  const loading = ref(true)
  let latest = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let soon: ReturnType<typeof setTimeout> | undefined

  async function reload(): Promise<void> {
    const mine = ++latest
    try {
      const got = await load()
      // An older answer that comes late is dropped.
      if (mine !== latest) return
      data.value = got
      error.value = ''
    } catch (err) {
      if (mine !== latest) return
      error.value = err instanceof ApiError ? err.message : 'The server cannot be reached.'
    } finally {
      if (mine === latest) loading.value = false
    }
  }

  // Several events in a row load once.
  if (follow) {
    watch(
      () => live.version,
      () => {
        clearTimeout(soon)
        soon = setTimeout(() => void reload(), 250)
      },
    )
  }
  if (sources.length > 0) {
    watch(sources, () => {
      loading.value = true
      void reload()
    })
  }
  onMounted(() => {
    void reload()
    if (follow) timer = setInterval(() => void reload(), 30_000)
  })
  onUnmounted(() => {
    latest++
    clearInterval(timer)
    clearTimeout(soon)
  })
  return { data, error, loading, reload }
}
