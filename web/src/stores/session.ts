import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ApiError, Client } from '@nuthatch/api'
import type { Role, Session } from '@nuthatch/api'

/**
 * Built as the app (`pnpm build:app`): not served by a nuthatch server,
 * but wrapped for a phone. It asks which server to talk to, logs in for a
 * token of its own, and keeps both on the device.
 */
export const APP = import.meta.env.MODE === 'app'

interface Saved {
  server: string
  token: string
  id: number
}
const KEY = 'nuthatch.app'

function saved(): Saved | null {
  if (!APP) return null
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null
    return kept && typeof kept.server === 'string' && typeof kept.token === 'string' ? kept : null
  } catch {
    return null
  }
}

function connect(): Client {
  const kept = saved()
  return kept ? new Client({ base: kept.server, token: kept.token }) : new Client()
}

/** The one client of the page. In the app it is made anew at each login. */
export let api = connect()

/** The server the app talked to last, to offer it again. */
export function lastServer(): string {
  return (APP && localStorage.getItem(`${KEY}.server`)) || ''
}

/** A server's address as typed, as a URL: https unless said otherwise. */
export function serverUrl(typed: string): string {
  const text = typed.trim().replace(/\/+$/, '')
  if (text === '') throw new ApiError(0, 'Say which server.')
  const url = /^https?:\/\//.test(text) ? text : `https://${text}`
  try {
    return new URL(url).origin
  } catch {
    throw new ApiError(0, 'That is not the address of a server.')
  }
}

export const useSession = defineStore('session', () => {
  const session = ref<Session | null>(null)
  /** Whether the server has been asked who is logged in. */
  const asked = ref(false)

  async function load(): Promise<void> {
    try {
      // The app with no server yet has nobody to ask.
      session.value = APP && !saved() ? null : await api.session()
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err
      session.value = null
    } finally {
      asked.value = true
    }
  }

  async function login(user: string, password: string, server = ''): Promise<void> {
    if (APP) {
      const base = serverUrl(server)
      const made = await new Client({ base }).loginForToken(user, password, 'nuthatch app')
      localStorage.setItem(KEY, JSON.stringify({ server: base, token: made.token, id: made.id } satisfies Saved))
      localStorage.setItem(`${KEY}.server`, base)
      api = connect()
    } else {
      await api.login(user, password)
    }
    await load()
  }

  async function logout(): Promise<void> {
    const kept = saved()
    if (kept) {
      // The app's token is deleted at the server, and forgotten here.
      await api.deleteToken(kept.id).catch(() => undefined)
      localStorage.removeItem(KEY)
      api = connect()
    } else {
      await api.logout().catch(() => undefined)
    }
    session.value = null
  }

  function has(role: Role): boolean {
    return session.value?.roles.includes(role) ?? false
  }

  return { session, asked, load, login, logout, has }
})
