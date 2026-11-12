import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Page, expect } from '@playwright/test'

export const password = process.env.NUTHATCH_TEST_PASSWORD ?? ''
export const ENGINES = ['naemon', 'checkd'] as const
const run = join(dirname(fileURLToPath(import.meta.url)), '../../dev/run')

export async function login(page: Page, user: string, pass = password) {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('User').fill(user)
  await page.getByLabel('Password').fill(pass)
  await page.getByRole('button', { name: 'Log in' }).click()
  if (pass === password) await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
}

/** The page must not scroll sideways, whatever the width. */
export async function fits(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(wider).toBeLessThanOrEqual(0)
}

/** Asks an engine directly, past nuthatch: what the engine itself says. */
export function livestatus(engine: string, request: string): Promise<unknown[][]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = connect({ path: join(run, engine, 'live') })
    socket.on('connect', () => socket.end(`${request}\nOutputFormat: json\n\n`))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '[]') as unknown[][]))
  })
}

/** The rows of a list as the page shows them: host, service, backend. */
export async function listed(page: Page, table = page.locator('table.rows').first()): Promise<string[]> {
  return table.locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => {
      const text = (selector: string) => row.querySelector(selector)?.textContent?.trim() ?? ''
      return [text('.host a'), text('.service a'), text('.host .backend')].join('|')
    }),
  )
}
