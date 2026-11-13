// Keeping an installed nuthatch (PWA) on the newest version without
// reinstalling. Every build writes version.json with its own id; the page
// knows the id it was built with. A page that was in the background and
// comes back finds a newer build and reloads; one in use shows a bar
// instead, so nothing being typed is lost. Not in the phone app, which
// carries its own files.

import { ref } from 'vue'

/** A newer build is on the server, and this page has not reloaded. */
export const updateReady = ref(false)

const EVERY = 5 * 60_000

export async function latestBuild(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && typeof (body as { build?: unknown }).build === 'string'
      ? (body as { build: string }).build
      : null
  } catch {
    return null
  }
}

/** What to do about the build found: nothing, reload, or say so. */
export function decide(found: string | null, mine: string, mayReload: boolean): 'none' | 'reload' | 'tell' {
  if (found === null || found === mine) return 'none'
  return mayReload ? 'reload' : 'tell'
}

async function check(mayReload: boolean): Promise<void> {
  const step = decide(await latestBuild(), __NUTHATCH_BUILD__, mayReload)
  if (step === 'reload') location.reload()
  else if (step === 'tell') updateReady.value = true
}

/**
 * Starts looking for newer builds: when the page comes back from the
 * background, reloading at once if `quiet` says nothing would be lost,
 * and every five minutes while it is shown.
 */
export function watchForUpdates(quiet: () => boolean): void {
  if (import.meta.env.MODE === 'app' || !import.meta.env.PROD) return
  let wasHidden = false
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      wasHidden = true
      return
    }
    void check(wasHidden && quiet())
    wasHidden = false
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void check(false)
  }, EVERY)
}
