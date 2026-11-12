// Phase 4: a dashboard is made and shared; it shows each user what is
// theirs to see, and follows what happens.
import { type Page, expect, test } from '@playwright/test'
import { ENGINES, fits, livestatus, login, send } from './helpers'

const sum = async (page: Page, box: string) => {
  const numbers = await page.getByRole('region', { name: box }).locator('.tile strong').allInnerTexts()
  return numbers.reduce((total, n) => total + Number(n), 0)
}

test('a shared dashboard shows each user their own, and follows a result', async ({ page }) => {
  const title = `Shared ${test.info().project.name} ${Date.now()}`
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine')
  let hosts = 0
  let opsHosts = 0
  for (const engine of ENGINES) {
    hosts += Number((await livestatus(engine, 'GET hosts\nStats: state >= 0'))[0]?.[0])
    opsHosts += Number((await livestatus(engine, 'GET hosts\nAuthUser: ops\nStats: state >= 0'))[0]?.[0])
  }

  await login(page, 'admin')
  await page.getByRole('link', { name: 'Dashboards' }).click()
  await page.getByLabel('A new dashboard').fill(title)
  await page.getByRole('button', { name: 'Make it' }).click()
  await expect(page.getByRole('heading', { name: 'Change the dashboard' })).toBeVisible()

  await page.getByLabel('Add a box').selectOption('problems')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByLabel('Add a box').selectOption('object')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const box = page.getByRole('group', { name: /Box 4/ })
  await box.getByLabel('Backend').selectOption('naemon')
  await box.getByLabel('Host').fill('passive1')
  await box.getByLabel('Service').fill('a')
  await page.getByLabel('Add a box').selectOption('log')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('group', { name: /Box 5/ }).getByRole('button', { name: 'Move up' }).click()
  await expect(page.getByRole('group', { name: /Box 4/ })).toContainText('The latest alerts')
  await page.getByLabel(/Shared/).check()
  await fits(page)
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(page.locator('.dashboard > section')).toHaveCount(5)
  await expect.poll(() => sum(page, 'Hosts')).toBe(hosts)
  const object = page.getByRole('region', { name: 'passive1 / a' })
  await expect(object.locator('.badge')).toHaveText('OK')
  await fits(page)

  // A result comes in: the boxes follow without a reload of the page.
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;2;broken for the dashboard')
  await expect(object.locator('.badge')).toHaveText('Critical', { timeout: 15_000 })
  await expect(object).toContainText('broken for the dashboard')
  await expect(page.getByRole('region', { name: 'Unhandled service problems' })).toContainText('passive1')
  await expect(page.getByRole('region', { name: 'Alerts' })).toContainText('broken for the dashboard')
  const url = page.url()
  await page.getByRole('button', { name: 'Log out' }).click()

  // The same dashboard, as ops.
  await login(page, 'ops')
  await page.getByRole('link', { name: 'Dashboards' }).click()
  await expect(page.locator('.managed li', { hasText: title })).toContainText('by admin')
  await page.goto(url)
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect.poll(() => sum(page, 'Hosts')).toBe(opsHosts)
  expect(opsHosts).toBeLessThan(hosts)
  await expect(page.getByRole('region', { name: 'passive1 / a' })).toContainText('not one of yours')
  await expect(page.getByRole('region', { name: 'Unhandled service problems' })).not.toContainText('passive1')
  await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(0)
  await fits(page)
  await page.getByRole('button', { name: 'Log out' }).click()

  // Its owner deletes it.
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine')
  await login(page, 'admin')
  await page.goto(url)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/\/dashboards$/)
  await expect(page.locator('.managed li', { hasText: title })).toHaveCount(0)
})

test('a dashboard that is not shared is its owner\'s alone', async ({ page }) => {
  const title = `Private ${test.info().project.name} ${Date.now()}`
  await login(page, 'admin')
  await page.goto('/dashboards')
  await page.getByLabel('A new dashboard').fill(title)
  await page.getByRole('button', { name: 'Make it' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  const url = page.url()
  await page.getByRole('button', { name: 'Log out' }).click()
  await login(page, 'ops')
  await page.goto(url)
  await expect(page.getByText('There is no such dashboard, or it is not shared.')).toBeVisible()
  await page.goto('/dashboards')
  await expect(page.locator('.managed li', { hasText: title })).toHaveCount(0)
})
