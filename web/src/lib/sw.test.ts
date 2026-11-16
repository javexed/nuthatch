// The service worker (public/sw.js), run with stand-ins for what a
// browser gives it: what it keeps, and what it never keeps.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function worker(answers: Record<string, Response>) {
  const handlers: Record<string, (event: unknown) => void> = {}
  const kept = new Map<string, Response>()
  const cache = {
    match: async (request: Request) => kept.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void kept.set(request.url, response),
  }
  const self = {
    location: { origin: 'https://n.example.test' },
    registration: { scope: 'https://n.example.test/' },
    addEventListener: (name: string, handler: (event: unknown) => void) => (handlers[name] = handler),
  }
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true }
  const fetch = async (request: Request) => answers[new URL(request.url).pathname]?.clone() ?? new Response('', { status: 404 })
  new Function('self', 'caches', 'fetch', readFileSync(join(import.meta.dirname, '../../public/sw.js'), 'utf8'))(self, caches, fetch)
  const get = async (path: string): Promise<Response | undefined> => {
    let answer: Promise<Response> | undefined
    handlers.fetch?.({ request: new Request(`https://n.example.test${path}`), respondWith: (r: Promise<Response>) => (answer = r) })
    return answer
  }
  return { get, kept }
}

describe('the service worker', () => {
  it('keeps the build files, and never an error or a page in their place', async () => {
    const sw = worker({
      '/assets/app-1.js': new Response('code', { headers: { 'content-type': 'text/javascript' } }),
      '/assets/app-old.js': new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    })
    expect(await (await sw.get('/assets/app-1.js'))?.text()).toBe('code')
    await sw.get('/assets/app-old.js')
    await sw.get('/assets/gone.js')
    expect([...sw.kept.keys()]).toEqual(['https://n.example.test/assets/app-1.js'])
    // Pages and the API go to the server, untouched.
    expect(await sw.get('/api/v1/session')).toBeUndefined()
    expect(await sw.get('/problems')).toBeUndefined()
  })
})
