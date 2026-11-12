import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ApiError, Client } from '../api/client'
import type { Role, Session } from '../api/types'

/** The one client of the page. */
export const api = new Client()

export const useSession = defineStore('session', () => {
  const session = ref<Session | null>(null)
  /** Whether the server has been asked who is logged in. */
  const asked = ref(false)

  async function load(): Promise<void> {
    try {
      session.value = await api.session()
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err
      session.value = null
    } finally {
      asked.value = true
    }
  }

  async function login(user: string, password: string): Promise<void> {
    await api.login(user, password)
    await load()
  }

  async function logout(): Promise<void> {
    await api.logout().catch(() => undefined)
    session.value = null
  }

  function has(role: Role): boolean {
    return session.value?.roles.includes(role) ?? false
  }

  return { session, asked, load, login, logout, has }
})
