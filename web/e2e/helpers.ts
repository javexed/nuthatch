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

/** Sends an engine an external command directly. */
export function send(engine: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: join(run, engine, 'live') })
    socket.on('connect', () => socket.end(`COMMAND [${Math.floor(Date.now() / 1000)}] ${command}\n\n`))
    socket.on('error', reject)
    socket.on('close', () => resolve())
  })
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export const seconds = () => Math.floor(Date.now() / 1000)

/** Waits for the start of a second, so that what follows falls early in one. */
export async function nextSecond(): Promise<number> {
  await sleep(1000 - (Date.now() % 1000) + 20)
  return seconds()
}

/** On a narrow screen, opens the bottom bar's More sheet; elsewhere nothing. */
export async function openMore(page: Page) {
  const more = page.getByRole('button', { name: 'More' })
  if (await more.isVisible()) await more.click()
}

/** Goes to a page from the menu: the top bar, or More on a narrow screen. */
export async function goTo(page: Page, name: string) {
  const link = page.getByRole('link', { name, exact: true })
  if (!(await link.isVisible())) await openMore(page)
  await link.click()
}

export async function logout(page: Page) {
  const button = page.getByRole('button', { name: 'Log out' })
  if (!(await button.isVisible())) await openMore(page)
  await button.click()
}

/** Chooses a backend on the Config page and waits for its config. */
export async function chooseBackend(page: Page, engine: string) {
  const select = page.locator('select[name=backend]')
  if ((await select.inputValue()) !== engine) {
    const loaded = page.waitForResponse((r) => r.url().endsWith(`/api/v1/config/${engine}`) && r.request().method() === 'GET')
    await select.selectOption(engine)
    await loaded
  }
  await expect(page.getByRole('button', { name: 'Add a host', exact: true })).toBeEnabled()
}
