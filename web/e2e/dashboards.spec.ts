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

  const KIND: Record<string, string> = { problems: 'Problems', object: 'Host or service', log: 'Log' }
  const addPanel = async (kind: string) => {
    await page.getByRole('toolbar', { name: 'Add a panel' }).getByRole('button', { name: `+ ${KIND[kind]}` }).click()
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

test('a panel dragged in from the tray, set up from lists, and one added from a service', async ({ page }) => {
  const title = `Tray ${test.info().project.name} ${Date.now()}`
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine|load=0.5;1;2 users=3')
  await login(page, 'admin')
  await page.goto('/dashboards')
  await page.getByLabel('A new dashboard').fill(title)
  await page.getByRole('button', { name: 'Make it' }).click()
  const tray = page.getByRole('toolbar', { name: 'Add a panel' })
  const settings = page.getByRole('complementary', { name: 'Panel settings' })
  if (test.info().project.name === 'desktop') {
    // Dragged to the top left: it lands there, and the totals make room.
    const from = await tray.getByRole('button', { name: '+ Number' }).boundingBox()
    const grid = await page.locator('.dash-grid').boundingBox()
    if (!from || !grid) throw new Error('no boxes')
    await page.mouse.move(from.x + 10, from.y + 10)
    await page.mouse.down()
    await page.mouse.move(grid.x + 30, grid.y + 20, { steps: 10 })
    await expect(page.locator('.drop-ghost')).toBeVisible()
    await page.mouse.up()
    await expect(page.locator('.drop-ghost')).toHaveCount(0)
    await expect(settings).toBeVisible()
    const panels = await page.locator('.dash-grid > section').evaluateAll((all) => all.map((s) => ({ top: s.getBoundingClientRect().top, chosen: s.classList.contains('chosen') })))
    const chosen = panels.find((p) => p.chosen)
    expect(chosen?.top).toBeLessThanOrEqual(Math.min(...panels.map((p) => p.top)) + 1)
  } else {
    await tray.getByRole('button', { name: '+ Number' }).click()
  }
  // Chosen from lists, not typed blind.
  await settings.getByLabel('Backend').selectOption('naemon')
  await expect(settings.locator('#dash-hosts option[value="passive1"]')).toHaveCount(1)
  await settings.getByLabel('Host').fill('nosuchhost')
  await expect(settings.getByLabel('Host')).toHaveAttribute('aria-invalid', 'true')
  await settings.getByLabel('Host').fill('passive1')
  await expect(settings.getByLabel('Host')).toHaveAttribute('aria-invalid', 'false')
  await expect(settings.locator('#dash-services option[value="a"]')).toHaveCount(1)
  await settings.getByLabel('Service').fill('a')
  await expect(settings.getByLabel('Metric').locator('option')).toHaveText(['First', 'load · 0.5', 'users · 3'])
  await settings.getByLabel('Metric').selectOption('users')
  await settings.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('region', { name: 'passive1 / a · users' })).toBeVisible()
  const url = page.url()
  await fits(page)

  // From the service's page: a graph of load, onto this dashboard.
  await page.goto('/service/naemon/passive1/a')
  await page.getByRole('button', { name: 'Add to dashboard' }).click()
  const form = page.getByRole('form', { name: 'Add to dashboard' })
  await form.getByLabel('Dashboard').selectOption({ label: title })
  await form.getByLabel('Graph').check()
  await form.getByLabel('Metric').selectOption('load')
  await form.getByRole('button', { name: 'Add' }).click()
  await form.getByRole('status').click()
  await expect(page).toHaveURL(new RegExp(`${new URL(url).pathname}$`))
  await expect(page.getByRole('region', { name: 'passive1 / a · load' })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
})
