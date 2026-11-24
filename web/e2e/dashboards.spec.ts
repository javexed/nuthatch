// Dashboards: everyone starts with an Overview; a template makes a whole
// dashboard in one click; a dashboard is changed in place and kept at
// once, with undo; one search box says what a panel shows; one range for
// all; subjects at the top, which panels follow; pins from a host's page;
// walls that take turns.
import { readFileSync } from 'node:fs'
import { type Page, expect, test } from '@playwright/test'
import { ENGINES, fits, livestatus, login, logout, send } from './helpers'

const desktop = () => test.info().project.name === 'desktop'
const panel = (page: Page, name: string | RegExp) => page.getByRole('region', { name, exact: true })
const tiles = (page: Page, name: string) => panel(page, name).locator('.status-tile')

async function deleteOpen(page: Page) {
  if (!desktop()) {
    // A narrow screen changes nothing: delete from a wide one.
    await page.setViewportSize({ width: 1280, height: 900 })
  }
  await page.getByRole('button', { name: 'More' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/\/dashboards$/)
}

test('everyone starts with an Overview, and a template makes a whole dashboard', async ({ page }) => {
  await login(page, 'ops')
  await page.goto('/dashboards')
  await page.locator('.managed').getByRole('link', { name: 'Overview' }).click()
  await expect(panel(page, 'All hosts')).toBeVisible()
  await expect(tiles(page, 'All hosts').first()).toBeVisible()
  await expect(panel(page, 'Service problems')).toBeVisible()
  await expect(panel(page, 'Alerts')).toBeVisible()
  await fits(page)

  await page.goto('/dashboards')
  await page.getByRole('button', { name: 'For a host or group' }).click()
  // Any host, then the groups, each with its number of hosts.
  await expect(page.locator('.find .found li:not(.head) button').first()).toHaveText('Any host')
  const group = page.locator('.find .found li:not(.head) button', { hasText: /\d+ hosts?$/ }).first()
  await expect(group).toContainText(/\d+ hosts?$/)
  const name = await group.evaluate((b) => b.firstChild?.textContent?.trim() ?? '')
  await group.click()
  await expect(panel(page, name)).toBeVisible()
  await expect(panel(page, `Uptime · ${name}`)).toContainText('%')
  await expect(panel(page, `Service problems · ${name}`)).toBeVisible()
  await expect(panel(page, `Recovered · ${name}`)).toBeVisible()
  await fits(page)
  await deleteOpen(page)
})

test('changed in place and kept at once, with undo; panels from the tray, told what to show by one search', async ({ page }) => {
  test.skip(!desktop(), 'changed on a wide screen')
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine|load=0.5;1;2 users=3')
  await login(page, 'admin')
  await page.setViewportSize({ width: 1280, height: 1400 })
  await page.goto('/dashboards')
  await page.getByRole('button', { name: 'Blank' }).click()
  const title = `Built ${Date.now()}`
  await page.getByLabel('Title').fill(title)
  // Empty: the tray is open already.
  const tray = page.getByRole('toolbar', { name: 'Add a panel' })

  // A graph dragged onto the grid; a list to browse opens inside it.
  const from = await tray.getByRole('button', { name: '+ Graph' }).boundingBox()
  const grid = await page.locator('.dash-grid').boundingBox()
  if (!from || !grid) throw new Error('no boxes')
  await page.mouse.move(from.x + 10, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(grid.x + 30, grid.y + 30, { steps: 10 })
  await expect(page.locator('.drop-ghost')).toBeVisible()
  await page.mouse.up()
  const settings = page.getByRole('complementary', { name: 'Panel settings' })
  const picker = page.getByRole('group', { name: 'Choose' })
  await picker.getByRole('button', { name: /^passive1\s*naemon$/ }).click()
  await picker.getByRole('button', { name: /^a$/ }).click()
  await picker.getByRole('button', { name: /^load\s*0\.5$/ }).click()
  await expect(picker).toHaveCount(0)
  // Another number, from its settings, by a few words.
  await panel(page, 'passive1 / a · load').getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: '+ Number' }).click()
  await picker.getByLabel('Search', { exact: true }).fill('passive1 users')
  await picker.getByRole('button', { name: /passive1 · a · users/ }).click()
  const metric = panel(page, 'passive1 / a')
  await metric.getByRole('button', { name: 'Settings' }).click()
  await expect(settings.locator('.series-list li')).toHaveCount(2)
  await settings.getByRole('button', { name: 'Close' }).click()
  await expect(metric).toContainText('0.5')

  // Hosts: one host, from the same kind of search.
  await tray.getByRole('button', { name: '+ Hosts' }).click()
  await expect(picker.getByRole('button', { name: 'All hosts' })).toBeVisible()
  await picker.getByLabel('Search', { exact: true }).fill('passive1')
  await picker.getByRole('button', { name: /^passive1\s*host · naemon$/ }).click()
  await expect(tiles(page, 'passive1').first()).toBeVisible()

  // A note: its web address is a link, nothing else is markup.
  await tray.getByRole('button', { name: '+ Note' }).click()
  await settings.getByLabel('Text').fill('Runbook https://example.test/run <b>not bold</b>')
  await settings.getByRole('button', { name: 'Close' }).click()
  const note = panel(page, 'Note')
  await expect(note.getByRole('link', { name: 'https://example.test/run' })).toHaveAttribute('href', 'https://example.test/run')
  await expect(note).toContainText('<b>not bold</b>')

  // Removed, and back with undo.
  await metric.getByRole('button', { name: 'Remove' }).click()
  await expect(metric).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(metric).toBeVisible()
  // One range for the whole dashboard.
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '7d' }).click()
  // Kept without a save: still there after a reload.
  await page.waitForTimeout(1200)
  await page.reload()
  await expect(page.getByLabel('Title')).toHaveValue(title)
  await expect(panel(page, 'passive1 / a')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.dash-grid > section')).toHaveCount(3)

  // Duplicated, then exported as a file.
  await panel(page, 'Note').getByRole('button', { name: 'Duplicate' }).click()
  await expect(page.locator('.dash-grid > section')).toHaveCount(4)
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'More' }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export' }).click()])
  const path = (await download.path()) ?? ''
  const file = JSON.parse(readFileSync(path, 'utf8')) as { title: string; range: string; widgets: unknown[] }
  expect([file.title, file.range, file.widgets.length]).toEqual([title, '7d', 4])

  // A file makes a dashboard again.
  await page.goto('/dashboards')
  await page.locator('input[type=file]').setInputFiles(path)
  await expect(page.getByLabel('Title')).toHaveValue(title)
  await expect(page.locator('.dash-grid > section')).toHaveCount(4)
  await deleteOpen(page)
  await page.getByRole('link', { name: title }).click()
  await deleteOpen(page)
})

test('the time: more ranges, earlier and later, a graph dragged across, a span typed, all in the link', async ({ page }) => {
  test.skip(!desktop(), 'dragged with a mouse')
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine|load=0.5;1;2')
  await login(page, 'admin')
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/dashboards')
  await page.getByRole('button', { name: 'Blank' }).click()
  await page.getByLabel('Title').fill(`Times ${Date.now()}`)
  const tray = page.getByRole('toolbar', { name: 'Add a panel' })
  await tray.getByRole('button', { name: '+ Graph' }).click()
  const picker = page.getByRole('group', { name: 'Choose' })
  await picker.getByRole('button', { name: /^passive1\s*naemon$/ }).click()
  await picker.getByRole('button', { name: /^a$/ }).click()
  await picker.getByRole('button', { name: /^load\s*0\.5$/ }).click()
  const times = page.getByRole('group', { name: 'Range' })

  // A range beyond the four at hand, kept with the dashboard.
  await times.getByRole('button', { name: 'Other times' }).click()
  await page.locator('.when-more').getByRole('button', { name: '30d' }).click()
  await expect(times.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true')

  // Earlier: thirty days before, in the address; Now: back to the range.
  await times.getByRole('button', { name: 'Earlier' }).click()
  await expect(page).toHaveURL(/from=\d+&to=\d+/)
  const span = (url: string) => {
    const q = new URL(url).searchParams
    return [Number(q.get('from')), Number(q.get('to'))] as const
  }
  const [from, to] = span(page.url())
  expect(Math.round((to - from) / 86400)).toBe(30)
  expect(Math.abs(Date.now() / 1000 - 30 * 86400 - to)).toBeLessThan(120)
  await times.getByRole('button', { name: 'Now' }).click()
  await expect(page).not.toHaveURL(/from=/)

  // Dragged across the graph: the dashboard looks at that stretch.
  const plot = await page.locator('.graph .plot').first().boundingBox()
  if (!plot) throw new Error('no graph')
  await page.mouse.move(plot.x + plot.width * 0.2, plot.y + plot.height / 2)
  await page.mouse.down()
  await page.mouse.move(plot.x + plot.width * 0.6, plot.y + plot.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(page).toHaveURL(/from=\d+&to=\d+/)
  const [a, b] = span(page.url())
  expect(Math.round((b - a) / 86400)).toBe(12)
  // The link opens on the same stretch.
  await page.reload()
  await expect(times.getByRole('button', { name: 'Zoom out' })).toBeVisible()

  // Or typed.
  await times.getByRole('button', { name: 'Other times' }).click()
  await page.getByLabel('From', { exact: true }).fill('2026-01-02T03:00')
  await page.getByLabel('To', { exact: true }).fill('2026-01-02T05:00')
  await page.getByRole('button', { name: 'Show' }).click()
  const [c, d] = span(page.url())
  expect(d - c).toBe(7200)
  expect(c).toBe(new Date(2026, 0, 2, 3).getTime() / 1000)
  await deleteOpen(page)
})

test('a shared dashboard shows each user their own, and its outline shows trouble', async ({ page }) => {
  test.skip(!desktop(), 'changed on a wide screen')
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine')
  let hosts = 0
  let opsHosts = 0
  for (const engine of ENGINES) {
    hosts += Number((await livestatus(engine, 'GET hosts\nStats: state >= 0'))[0]?.[0])
    opsHosts += Number((await livestatus(engine, 'GET hosts\nAuthUser: ops\nStats: state >= 0'))[0]?.[0])
  }
  await login(page, 'admin')
  await page.setViewportSize({ width: 1280, height: 1200 })
  await page.goto('/dashboards')
  await page.getByRole('button', { name: 'Blank' }).click()
  const title = `Shared ${Date.now()}`
  await page.getByLabel('Title').fill(title)
  // Empty: the tray is open already.
  const tray = page.getByRole('toolbar', { name: 'Add a panel' })
  const settings = page.getByRole('complementary', { name: 'Panel settings' })
  await tray.getByRole('button', { name: '+ Hosts' }).click()
  await page.getByRole('group', { name: 'Choose' }).getByRole('button', { name: 'All hosts' }).click()
  await tray.getByRole('button', { name: '+ Problems' }).click()
  await page.locator('.dash-grid > section').last().getByRole('button', { name: 'Settings' }).click()
  await settings.getByLabel('Host group').selectOption('passive')
  await settings.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByLabel('Shared').check()
  await expect(tiles(page, 'All hosts')).toHaveCount(hosts)

  // Trouble: the problems panel's outline turns red, without a reload.
  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;2;broken for the dashboard')
  await expect(panel(page, 'Service problems · passive')).toHaveClass(/outline-critical/, { timeout: 15_000 })
  await expect(panel(page, 'Service problems · passive')).toContainText('passive1')
  await page.waitForTimeout(1200)
  const url = page.url()
  await logout(page)

  await login(page, 'ops')
  await page.goto(url)
  await expect(tiles(page, 'All hosts')).toHaveCount(opsHosts)
  expect(opsHosts).toBeLessThan(hosts)
  await expect(panel(page, 'Service problems · passive')).not.toContainText('passive1')
  await page.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  await logout(page)

  await send('naemon', 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine')
  await login(page, 'admin')
  await page.goto(url)
  await deleteOpen(page)
})

test('subjects at the top: a host group, a service group, any host; the panels that follow show the one chosen', async ({ page }) => {
  await login(page, 'admin')
  await page.goto('/dashboards')
  await page.getByRole('button', { name: 'For a host or group' }).click()
  await page.getByLabel('Host or group', { exact: true }).fill('db')
  await page.getByRole('button', { name: /^db\s*host group$/ }).click()
  const subjects = page.getByRole('group', { name: 'Subjects' })
  await expect(subjects.getByRole('button', { name: 'db', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel(page, 'db')).toBeVisible()
  await expect(tiles(page, 'db').first()).toHaveText('db1')
  await expect(panel(page, 'Uptime · db')).toContainText('%')
  // A graph by its check: a line for each host of the group that has it.
  await expect(panel(page, 'disk · latency')).toContainText('db2')

  // Added on a phone too: a service group, whose services are its tiles.
  await subjects.getByRole('button', { name: 'Add a subject' }).click()
  await page.getByLabel('Host or group', { exact: true }).fill('disks')
  await page.getByRole('button', { name: /^disks\s*service group$/ }).click()
  await expect(panel(page, 'disks')).toBeVisible()
  await expect(tiles(page, 'disks').first()).toHaveText('db1 · disk')
  await expect(panel(page, 'Uptime · disks')).toContainText('OK')
  await expect(page).toHaveURL(/on=1/)

  // Any host, picked from a list; a graph of a check the host does not have says so.
  await subjects.getByRole('button', { name: 'Add a subject' }).click()
  await page.getByRole('button', { name: /^Any host$/ }).click()
  const chooser = subjects.getByRole('combobox', { name: 'Host' })
  // A host on two engines is named with each.
  await chooser.selectOption((await chooser.locator('option', { hasText: 'gw1' }).first().getAttribute('value')) ?? '')
  await expect(page).toHaveURL(/host=gw1/)
  await expect(panel(page, 'gw1')).toBeVisible()
  await expect(panel(page, 'disk · latency')).toContainText('None')

  // All: everything.
  await subjects.getByRole('button', { name: 'All' }).click()
  await expect(panel(page, 'All hosts')).toBeVisible()
  await fits(page)

  // Taken away again; the rest stay, and stay after a reload.
  await subjects.getByRole('button', { name: 'disks' }).click()
  await subjects.getByRole('button', { name: 'Remove disks' }).click()
  await expect(subjects.getByRole('button', { name: 'disks' })).toHaveCount(0)
  await page.waitForTimeout(1200)
  await page.reload()
  await expect(subjects.getByRole('button', { name: 'db', exact: true })).toBeVisible()
  await expect(subjects.getByRole('button', { name: 'disks' })).toHaveCount(0)
  await deleteOpen(page)
})

test('a panel follows the subject, or shows what it names', async ({ page }) => {
  test.skip(!desktop(), 'panels are arranged on a wide screen')
  await login(page, 'admin')
  await page.goto('/dashboards')
  await page.getByRole('button', { name: 'Blank' }).click()
  const subjects = page.getByRole('group', { name: 'Subjects' })
  await subjects.getByRole('button', { name: 'Add a subject' }).click()
  await page.getByLabel('Host or group', { exact: true }).fill('web')
  await page.getByRole('button', { name: /^web\s*host group$/ }).click()
  // With a subject, a panel from the tray follows it, and is marked so.
  await page.getByRole('toolbar', { name: 'Add a panel' }).getByRole('button', { name: '+ Uptime' }).click()
  await expect(panel(page, 'Uptime · web')).toBeVisible()
  await expect(panel(page, 'Uptime · web').locator('.follow-mark')).toBeVisible()
  // No longer following: it keeps what was chosen, whatever is chosen after.
  await panel(page, 'Uptime · web').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('complementary', { name: 'Panel settings' }).getByLabel('Follows the subject').uncheck()
  await subjects.getByRole('button', { name: 'All' }).click()
  await expect(panel(page, 'Uptime · web')).toBeVisible()
  await expect(panel(page, 'Uptime · web').locator('.follow-mark')).toHaveCount(0)
  await deleteOpen(page)
})

test('pinned from a host page with one click, then undone', async ({ page }) => {
  await login(page, 'viewer')
  const overview = async () => {
    await page.goto('/dashboards')
    await page.locator('.managed').getByRole('link', { name: 'Overview' }).click()
    await expect(panel(page, 'All hosts')).toBeVisible()
    return panel(page, 'passive1').count()
  }
  const before = await overview()
  // Pinned, then undone: the dashboard is as it was.
  await page.goto('/host/naemon/passive1')
  await page.getByRole('button', { name: 'Pin to a dashboard' }).click()
  await expect(page.locator('.pinned').getByRole('link', { name: 'Overview' })).toBeVisible()
  await page.locator('.pinned').getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('button', { name: 'Pin to a dashboard' })).toBeVisible()
  expect(await overview()).toBe(before)
  // Pinned: one more panel, there at once.
  await page.goto('/host/naemon/passive1')
  await page.getByRole('button', { name: 'Pin to a dashboard' }).click()
  await page.locator('.pinned').getByRole('link', { name: 'Overview' }).click()
  await expect(panel(page, 'passive1')).toHaveCount(before + 1)
})

test('dashboards take turns on a wall', async ({ page }) => {
  test.skip(!desktop(), 'one wall is enough')
  await login(page, 'admin')
  const ids: string[] = []
  for (const name of ['Turn A', 'Turn B']) {
    await page.goto('/dashboards')
    await page.getByRole('button', { name: 'Blank' }).click()
    await page.getByLabel('Title').fill(`${name} ${Date.now()}`)
    await page.waitForTimeout(1200)
    ids.push(/\/dashboard\/(\d+)/.exec(page.url())?.[1] ?? '')
  }
  await page.goto('/dashboards')
  for (const id of ids) await page.locator(`input[type=checkbox][value="${id}"]`).check()
  await page.getByLabel('Every').fill('5')
  await page.getByRole('button', { name: 'Wall' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${ids[0]}\\?`))
  await expect(page.locator('header.bar')).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/dashboard/${ids[1]}\\?`), { timeout: 10_000 })
  await expect(page).toHaveURL(new RegExp(`/dashboard/${ids[0]}\\?`), { timeout: 10_000 })
  await page.getByRole('button', { name: 'Exit' }).click()
  await expect(page.locator('header.bar')).toBeVisible()
  for (const id of ids) {
    await page.goto(`/dashboard/${id}`)
    await deleteOpen(page)
  }
})
