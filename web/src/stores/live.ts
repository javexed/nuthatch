// Keeping what a page shows current: loaded when the page opens, again
// when the server says something changed, and every half minute for what
// changes without an event (outputs, times of checks).

import { defineStore } from 'pinia'
import { type Ref, type WatchSource, onMounted, onUnmounted, ref, watch } from 'vue'
import { ApiError } from '@nuthatch/api'
import { api } from './session'

export const useLive = defineStore('live', () => {
  /** Goes up whenever something may have changed. */
  const version = ref(0)
  let stop: AbortController | null = null

  function start(): void {
    if (stop) return
    stop = new AbortController()
    void api.events(() => version.value++, stop.signal)
  }

  function end(): void {
    stop?.abort()
    stop = null
  }

  /** Something was just sent to an engine, which takes a moment to act. */
  function nudge(): void {
    for (const wait of [700, 2500]) setTimeout(() => version.value++, wait)
  }

  return { version, start, end, nudge }
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
