// Phase 6: the app build, served from an origin of its own as a phone's
// shell serves it, against a nuthatch server elsewhere: it asks for the
// server, logs in for a token, and acts with it.
import { expect, test } from '@playwright/test'
import { fits, livestatus, logout, password } from './helpers'

const APP = 'http://127.0.0.1:8097'
const SERVER = 'http://127.0.0.1:8092'
const queue = 'GET services\nColumns: acknowledged\nFilter: host_name = mail1\nFilter: description = queue'

test('the app logs in at a server for a token and acknowledges a problem', async ({ page }) => {
  await page.goto(`${APP}/`)
  await expect(page).toHaveURL(/#\/login/)
  await page.getByLabel('Server').fill(SERVER)
  await page.getByLabel('User').fill('admin')
  await page.getByLabel('Password').fill('wrong')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toHaveText('wrong user or password')

  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  // A token on the device, and no cookie.
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('nuthatch.app') ?? '{}') as { server?: string; token?: string })
  expect(kept.server).toBe(SERVER)
  expect(kept.token).toMatch(/^nh_/)
  expect(await page.context().cookies()).toEqual([])
  await expect(page.getByRole('region', { name: 'Hosts' }).locator('.tile strong').first()).not.toHaveText('0')
  await fits(page)

  // Closed and opened again: still logged in.
  await page.goto(`${APP}/`)
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()

  await page.getByRole('link', { name: 'Services', exact: true }).click()
  await page.getByLabel('Search').fill('queue')
  await page.locator('tr', { hasText: 'naemon' }).getByRole('link', { name: 'queue' }).click()
  await expect(page).toHaveURL(/#\/service\/naemon\/mail1\/queue/)
  await page.getByRole('button', { name: 'Acknowledge' }).click()
  await page.getByRole('textbox', { name: 'Comment' }).fill('from the app')
  await page.getByRole('dialog').getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.locator('.headline')).toContainText('acknowledged')
  expect((await livestatus('naemon', queue))[0]?.[0]).toBe(1)
  await fits(page)
  await page.getByRole('button', { name: 'Remove acknowledgement' }).click()
  await expect(page.locator('.headline')).not.toContainText('acknowledged')

  // Logging out deletes the token at the server and on the device.
  await logout(page)
  await expect(page).toHaveURL(/#\/login/)
  await expect(page.getByLabel('Server')).toHaveValue(SERVER)
  expect(await page.evaluate(() => localStorage.getItem('nuthatch.app'))).toBeNull()
  const after = await page.request.get(`${SERVER}/api/v1/session`, { headers: { Authorization: `Bearer ${kept.token ?? ''}` } })
  expect(after.status()).toBe(401)
})

test('a page from an origin the server does not list cannot call it', async ({ page }) => {
  await page.goto(`${SERVER}/login`)
  const result = await page.evaluate(async (server) => {
    // The other name of this machine: another origin to the browser.
    try {
      const answer = await fetch(`${server.replace('127.0.0.1', 'localhost')}/api/v1/session`)
      return `answered ${answer.status}`
    } catch {
      return 'blocked'
    }
  }, SERVER)
  expect(result).toBe('blocked')
})
