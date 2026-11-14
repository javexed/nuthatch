// Phase 4: a dashboard is made and shared; it shows each user what is
// theirs to see, and follows what happens.
import { type Page, expect, test } from '@playwright/test'
import { ENGINES, fits, goTo, livestatus, login, logout, send } from './helpers'

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
  await goTo(page, 'Dashboards')
  await page.getByLabel('A new dashboard').fill(title)
  await page.getByRole('button', { name: 'Make it' }).click()
  await expect(page.getByLabel('Title')).toHaveValue(title)

  const addPanel = async (kind: string) => {
    await page.getByLabel('Panel', { exact: true }).selectOption(kind)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
  }
  await addPanel('problems')
  await addPanel('object')
  const settings = page.getByRole('complementary', { name: 'Panel settings' })
  await settings.getByLabel('Backend').selectOption('naemon')
  await settings.getByLabel('Host').fill('passive1')
  await settings.getByLabel('Service').fill('a')
  await settings.getByRole('button', { name: 'Done' }).click()
  await addPanel('log')
  await settings.getByRole('button', { name: 'Done' }).click()
  await page.getByLabel(/Shared/).check()
  await fits(page)
  if (test.info().project.name === 'desktop') {
    // The log is dragged by its grip to the top left, and the others make room.
    await page.setViewportSize({ width: 1280, height: 1600 })
    const grip = page.getByRole('region', { name: 'Alerts' }).locator('.grip')
    const to = page.locator('.dash-grid').boundingBox()
    const from = await grip.boundingBox()
    const target = await to
    if (from && target) {
      await page.mouse.move(from.x + 4, from.y + 4)
      await page.mouse.down()
      await page.mouse.move(target.x + 10, target.y + 10, { steps: 8 })
      await page.mouse.up()
    }
    const log = await page.getByRole('region', { name: 'Alerts' }).boundingBox()
    const others = await page.locator('.dash-grid > section').evaluateAll((all) => all.map((s) => s.getBoundingClientRect().top))
    expect(log?.y).toBeLessThanOrEqual(Math.min(...others) + 1)
  }
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(page.locator('.dash-grid > section')).toHaveCount(5)
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
  // On a wall, the panels alone.
  await page.getByRole('button', { name: 'Wall' }).click()
  await expect(page.locator('header.bar')).toBeHidden()
  await page.getByRole('button', { name: 'Exit' }).click()
  await expect(page.locator('header.bar')).toBeVisible()
  const url = page.url()
  await logout(page)

  // The same dashboard, as ops.
  await login(page, 'ops')
  await goTo(page, 'Dashboards')
  await expect(page.locator('.managed li', { hasText: title })).toContainText('by admin')
  await page.goto(url)
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect.poll(() => sum(page, 'Hosts')).toBe(opsHosts)
  expect(opsHosts).toBeLessThan(hosts)
  await expect(page.getByRole('region', { name: 'passive1 / a' })).toContainText('Not found')
  await expect(page.getByRole('region', { name: 'Unhandled service problems' })).not.toContainText('passive1')
  // Shared: ops may change it, and not delete it.
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  await fits(page)
  await logout(page)

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
  await logout(page)
  await login(page, 'ops')
  await page.goto(url)
  await expect(page.getByText('Not found', { exact: true })).toBeVisible()
  await page.goto('/dashboards')
  await expect(page.locator('.managed li', { hasText: title })).toHaveCount(0)
})
