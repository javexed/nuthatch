// Phase 1: what people see and do, on both engines at once.
import { type Page, expect, test } from '@playwright/test'
import { ENGINES, fits, goTo, listed, livestatus, login, logout, openMore } from './helpers'

const total = async (page: Page, region: string) => {
  const tiles = await page.getByRole('region', { name: region }).locator('.tile strong').allInnerTexts()
  return tiles.reduce((sum, n) => sum + Number(n), 0)
}

test('the overview counts what the engines count, for admin and for ops', async ({ page }) => {
  for (const [user, auth] of [['admin', ''], ['ops', 'AuthUser: ops\n']] as const) {
    let hosts = 0
    let services = 0
    for (const engine of ENGINES) {
      hosts += Number((await livestatus(engine, `GET hosts\n${auth}Stats: state >= 0`))[0]?.[0])
      services += Number((await livestatus(engine, `GET services\n${auth}Stats: state >= 0`))[0]?.[0])
    }
    await login(page, user)
    await expect.poll(() => total(page, 'Hosts')).toBe(hosts)
    await expect.poll(() => total(page, 'Services')).toBe(services)
    await fits(page)
    await logout(page)
  }
})

test("ops' lists are what the engines give ops, and no more", async ({ page }) => {
  const hosts: string[] = []
  const services: string[] = []
  for (const engine of ENGINES) {
    for (const [name] of await livestatus(engine, 'GET hosts\nAuthUser: ops\nColumns: name')) hosts.push(`${String(name)}||${engine}`)
    for (const [host, description] of await livestatus(engine, 'GET services\nAuthUser: ops\nColumns: host_name description')) {
      services.push(`${String(host)}|${String(description)}|${engine}`)
    }
  }
  expect(hosts.length).toBe(4)
  await login(page, 'ops')
  await page.getByRole('link', { name: 'Hosts', exact: true }).click()
  await expect.poll(async () => (await listed(page)).sort()).toEqual(hosts.sort())
  await page.getByRole('link', { name: 'Services', exact: true }).click()
  await expect.poll(async () => (await listed(page)).sort()).toEqual(services.sort())
  await fits(page)

  // A host that is not ops' own is not there for ops, by its address either.
  await page.goto('/host/naemon/db1')
  await expect(page.getByText('not one of yours')).toBeVisible()
})

test('the service list filters, sorts over both engines, and pages', async ({ page }) => {
  await login(page, 'admin')
  await page.getByRole('link', { name: 'Services', exact: true }).click()
  await expect(page.getByText('1–50 of 72')).toBeVisible()

  // Sorted by host, then service, then engine: the same on every page.
  const all: string[] = []
  for (const engine of ENGINES) {
    for (const [host, description] of await livestatus(engine, 'GET services\nColumns: host_name description')) all.push(`${String(host)}|${String(description)}|${engine}`)
  }
  all.sort((a, b) => {
    const [x, y] = [a.split('|'), b.split('|')]
    return (x[0] ?? '').localeCompare(y[0] ?? '') || (x[1] ?? '').localeCompare(y[1] ?? '') || (x[2] ?? '').localeCompare(y[2] ?? '')
  })
  await expect.poll(() => listed(page)).toEqual(all.slice(0, 50))
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('51–72 of 72')).toBeVisible()
  await expect.poll(() => listed(page)).toEqual(all.slice(50))
  await expect(page).toHaveURL(/offset=50/)
  await fits(page)

  // A state and a search, kept in the address.
  await page.getByRole('button', { name: 'Warning' }).click()
  await page.getByLabel('Search').fill('nas1')
  await expect(page).toHaveURL(/state=1/)
  await expect(page).toHaveURL(/q=nas1/)
  await expect.poll(() => listed(page)).toEqual(['nas1|disk|checkd', 'nas1|disk|naemon'])
  await page.reload()
  await expect.poll(() => listed(page)).toEqual(['nas1|disk|checkd', 'nas1|disk|naemon'])
  await expect(page.getByLabel('Search')).toHaveValue('nas1')

  // Sorting by a column, and back.
  await page.goto('/services?q=ping')
  await expect.poll(async () => (await listed(page)).length).toBe(20)
  if ((page.viewportSize()?.width ?? 0) < 700) await page.getByLabel('Sort by').selectOption('-host_name')
  else {
    await page.getByRole('button', { name: /^Host/ }).click()
    await expect(page.getByRole('button', { name: 'Host ▼' })).toBeVisible()
  }
  await expect.poll(async () => (await listed(page))[0]).toBe('web2|ping|checkd')
  await expect(page).toHaveURL(/sort=-host_name/)
})

test('problems lists what is wrong, and groups lead to their members', async ({ page }) => {
  await login(page, 'admin')
  await page.getByRole('link', { name: /^Problems/ }).click()
  // nas1/disk is always WARNING in the demo site.
  const services = page.locator('table.rows').last()
  await expect.poll(async () => (await listed(page, services)).filter((row) => row.startsWith('nas1|disk|'))).toHaveLength(2)
  await fits(page)

  await goTo(page, 'Groups')
  await expect(page.locator('.groups > li')).toHaveCount(14)
  await fits(page)
  await page.locator('.groups > li', { hasText: 'naemon' }).getByRole('link', { name: 'Web', exact: true }).click()
  await expect(page).toHaveURL(/\/hosts\?group=web/)
  await expect.poll(async () => (await listed(page)).sort()).toEqual(['web1||checkd', 'web1||naemon', 'web2||checkd', 'web2||naemon'])
})

test('ops sees only the group it sees all of', async ({ page }) => {
  await login(page, 'ops')
  await goTo(page, 'Groups')
  await expect(page.locator('.groups > li')).toHaveCount(2)
  await expect(page.locator('.groups > li').first()).toContainText('Web')
})

for (const engine of ENGINES) {
  test(`acting on a service of ${engine}: comment, acknowledge, downtime, check`, async ({ page }) => {
    await login(page, 'admin')
    await page.goto(`/service/${engine}/mail1/queue`)
    await expect(page.getByRole('heading', { name: 'queue' })).toBeVisible()
    await expect(page.locator('.headline .badge')).toHaveText('Warning')
    const card = (title: string) => page.locator('section.card', { has: page.getByRole('heading', { name: title }) })
    const stamp = `e2e ${Date.now()}`

    await page.getByRole('button', { name: 'Comment' }).click()
    await page.getByRole('textbox', { name: 'Comment' }).fill(`${stamp} comment`)
    await page.getByRole('button', { name: 'Add comment' }).click()
    await expect(card('Comments')).toContainText(`${stamp} comment`)
    await expect(card('Comments')).toContainText('admin')

    await page.getByRole('button', { name: 'Acknowledge' }).click()
    await page.getByRole('textbox', { name: 'Comment' }).fill(`${stamp} ack`)
    await page.getByRole('dialog').getByRole('button', { name: 'Acknowledge' }).click()
    await expect(page.locator('.headline')).toContainText('acknowledged')
    const [[acknowledged]] = (await livestatus(engine, 'GET services\nColumns: acknowledged\nFilter: host_name = mail1\nFilter: description = queue')) as [[number]]
    expect(acknowledged).toBe(1)
    await page.getByRole('button', { name: 'Remove acknowledgement' }).click()
    await expect(page.locator('.headline')).not.toContainText('acknowledged')

    await page.getByRole('button', { name: 'Downtime' }).click()
    await page.getByRole('textbox', { name: 'Comment' }).fill(`${stamp} downtime`)
    await page.getByRole('button', { name: 'Schedule downtime' }).click()
    await expect(card('Downtimes')).toContainText(`${stamp} downtime`)
    await expect(page.locator('.headline')).toContainText('in a downtime')
    await fits(page)
    await card('Downtimes').getByRole('button', { name: 'Remove' }).click()
    await expect(card('Downtimes')).toHaveCount(0)

    const before = (await livestatus(engine, 'GET services\nColumns: last_check\nFilter: host_name = mail1\nFilter: description = queue'))[0]?.[0] as number
    await page.getByRole('button', { name: 'Check now' }).click()
    await expect(page.getByRole('status')).toHaveText('Asked for a check.')
    await expect
      .poll(async () => (await livestatus(engine, 'GET services\nColumns: last_check\nFilter: host_name = mail1\nFilter: description = queue'))[0]?.[0], { timeout: 15000 })
      .toBeGreaterThan(before)
    // The page waited for the result, and shows it without being asked.
    await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled({ timeout: 20_000 })

    // Tidy up: the comments of this test go.
    while ((await card('Comments').getByRole('button', { name: 'Delete' }).count()) > 0) {
      const count = await card('Comments').getByRole('button', { name: 'Delete' }).count()
      await card('Comments').getByRole('button', { name: 'Delete' }).first().click()
      await expect(card('Comments').getByRole('button', { name: 'Delete' })).toHaveCount(count - 1)
    }
  })
}

test('several hosts at once from the list', async ({ page }) => {
  await login(page, 'admin')
  await page.goto('/hosts?q=lab')
  await expect.poll(async () => (await listed(page)).length).toBe(4)
  await page.getByLabel('Tick all').check()
  await expect(page.getByRole('toolbar')).toContainText('4 ticked')
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('status')).toHaveText('Asked for 4 checks.')
  await page.getByRole('button', { name: 'Downtime' }).click()
  await expect(page.getByRole('dialog')).toContainText('4 objects')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await fits(page)
})

test('viewer looks and cannot touch; ops acts on its own', async ({ page }) => {
  await login(page, 'viewer')
  await page.goto('/host/naemon/web1')
  await expect(page.getByRole('heading', { name: 'web1' })).toBeVisible()
  await expect(page.locator('.headline .badge')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check now' })).toHaveCount(0)
  await expect(page.getByLabel('Tick all')).toHaveCount(0)
  await logout(page)

  await login(page, 'ops')
  await page.goto('/host/checkd/web1')
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('status')).toHaveText('Asked for a check.')
  await expect(page.locator('table.rows tbody tr')).toHaveCount(4)
})

test('on a phone: the bar at the bottom, with the open problems counted', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'the bottom bar is for narrow screens')
  await login(page, 'admin')
  await expect(page.getByRole('navigation', { name: 'Pages', exact: true })).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Main pages' })).toBeVisible()
  // The demo site always has problems; the badge and the overview agree.
  const badge = page.locator('.tabbar .badge')
  await expect(badge).toHaveText(/^[1-9]\d*\+?$/)
  await expect(page.locator('.banner')).toContainText(`${await badge.innerText()} problem`)
  await openMore(page)
  await expect(page.getByRole('link', { name: 'History' })).toBeVisible()
  await page.getByRole('link', { name: 'History' }).click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await fits(page)
})
