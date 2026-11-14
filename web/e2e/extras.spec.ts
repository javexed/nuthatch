// What checkd has beyond Naemon, set up from the interface: a service
// that is told its result, one that stands for others, and a downtime for
// everything that fits a pattern (which works on either engine).
import { execFileSync } from 'node:child_process'
import { readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { ENGINES, fits, goTo, livestatus, login, send, sleep } from './helpers'

const dev = join(dirname(fileURLToPath(import.meta.url)), '../../dev')
test.setTimeout(180_000)

test.beforeAll(async () => {
  const managed = join(dev, 'run', 'checkd', 'managed')
  const left = readdirSync(managed)
  for (const file of left) unlinkSync(join(managed, file))
  if (left.length > 0) {
    execFileSync(join(dev, 'restart'), ['checkd'])
    await sleep(3000)
  }
})

test('a service that takes pushes and one that stands for others, on checkd', async ({ page, request }) => {
  const name = `extras-${test.info().project.name}`
  await login(page, 'admin')
  await goTo(page, 'Config')
  await page.locator('select[name=backend]').selectOption('checkd')
  await expect(page.getByText('on checkd')).toBeVisible()
  await page.getByRole('button', { name: 'Add a host', exact: true }).click()
  await page.getByRole('button', { name: 'Fill in the form myself' }).click()
  await page.getByLabel('Name').first().fill(name)
  await page.getByLabel('Address').fill('192.0.2.91')

  await page.getByRole('button', { name: 'Add a service' }).click()
  const pushed = page.getByRole('group', { name: 'Service 1' })
  await pushed.getByLabel('Name').fill('backup')
  await pushed.getByLabel('How its state is found').selectOption('push')
  await pushed.getByLabel('Alarm when nothing came').fill('25')

  await page.getByRole('button', { name: 'Add a service' }).click()
  const all = page.getByRole('group', { name: 'Service 2' })
  await all.getByLabel('Name').fill('web servers')
  await all.getByLabel('How its state is found').selectOption('aggregate')
  await all.getByLabel('Members').fill('web1\nweb2\ndb1')
  await all.getByLabel('How many must be OK').fill('2')
  await fits(page)

  await page.getByRole('button', { name: 'Save and apply' }).click()
  await expect(page.getByRole('status')).toContainText(`${name} is saved, and the engine has it.`, { timeout: 90_000 })
  const services = await livestatus('checkd', `GET services\nColumns: description check_command active_checks_enabled\nFilter: host_name = ${name}`)
  expect(services.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
    ['backup', 'nuthatch_pushed', 0],
    ['web servers', 'nuthatch_aggregate!--min 2 web1 web2 db1', 1],
  ])

  // The service's page says how it is told, and the address works.
  await page.goto(`/service/checkd/${name}/backup`)
  const section = page.getByRole('region', { name: 'Takes pushes' })
  await expect(section).toContainText('It goes CRITICAL when nothing comes for 25 hours.')
  await section.getByRole('button', { name: 'Show the address to call' }).click()
  const call = (await section.locator('pre.call').innerText()).trim()
  expect(call).toMatch(/^curl -fsS http:\/\/127\.0\.0\.1:6560\/api\/v1\/push\/[0-9a-f]{32}$/)
  await fits(page)
  const answer = await request.get(`${call.replace('curl -fsS ', '')}?output=${encodeURIComponent('42 files copied')}`)
  expect(answer.status()).toBe(200)
  await expect(page.locator('.detail, main').first()).toContainText('42 files copied', { timeout: 20_000 })

  // The one that stands for others says how many are OK, once it is worked out.
  await page.goto(`/service/checkd/${name}/web servers`)
  await expect(page.locator('main')).toContainText(/AGGREGATE \w+ - \d of 3 are OK, 2 needed/, { timeout: 90_000 })

  // It opens again as what it is, and keeps its address.
  await page.goto('/config')
  await page.locator('select[name=backend]').selectOption('checkd')
  await page.locator('.managed li', { hasText: name }).getByRole('button', { name: 'Change' }).click()
  await expect(page.getByRole('group', { name: 'Service 1' }).getByLabel('How its state is found')).toHaveValue('push')
  await expect(page.getByRole('group', { name: 'Service 1' })).toContainText('It keeps the address it has.')
  await expect(page.getByRole('group', { name: 'Service 2' }).getByLabel('Members')).toHaveValue('web1\nweb2\ndb1')
  await page.getByRole('button', { name: 'Cancel' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.locator('.managed li', { hasText: name }).getByRole('button', { name: 'Take out' }).click()
  await expect(page.getByRole('status')).toContainText('is taken out.', { timeout: 90_000 })
})

test('Naemon has neither of the two kinds of service', async ({ page }) => {
  await login(page, 'admin')
  await goTo(page, 'Config')
  await page.locator('select[name=backend]').selectOption('naemon')
  await expect(page.getByText('on naemon')).toBeVisible()
  await page.getByRole('button', { name: 'Add a host', exact: true }).click()
  await page.getByRole('button', { name: 'Fill in the form myself' }).click()
  await page.getByRole('button', { name: 'Add a service' }).click()
  await expect(page.getByRole('group', { name: 'Service 1' }).getByLabel('Check command')).toBeVisible()
  await expect(page.getByLabel('How its state is found')).toHaveCount(0)
})

for (const engine of ENGINES) {
  test(`a downtime for every host that fits, on ${engine}`, async ({ page }) => {
    const comment = `many ${engine} ${test.info().project.name} ${Date.now()}`
    await login(page, 'admin')
    await goTo(page, 'Hosts')
    await page.getByRole('button', { name: 'Downtime for many' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('select[name=backend]').selectOption(engine)
    await dialog.getByLabel('Hosts').fill('web?')
    await dialog.getByLabel('Comment').fill(comment)
    await dialog.getByRole('button', { name: 'See what fits' }).click()
    await expect(dialog.getByRole('status')).toContainText('2 fit')
    await expect(dialog.getByRole('status')).toContainText('web1')
    await fits(page)
    await dialog.getByRole('button', { name: 'Schedule downtime for 2' }).click()
    await expect(dialog).toContainText('2 hosts are in a downtime')
    const made = await livestatus(engine, `GET downtimes\nColumns: host_name author id\nFilter: comment = ${comment}`)
    expect(made.map((row) => row[0]).sort()).toEqual(['web1', 'web2'])
    expect(made[0]?.[1]).toBe('admin')
    await dialog.getByRole('button', { name: 'Close' }).click()
    // Other tests want these hosts to notify.
    for (const row of made) await send(engine, `DEL_HOST_DOWNTIME;${String(row[2])}`)
  })
}

test('New on the Hosts, Services and Groups pages', async ({ page }) => {
  const group = `new-group-${test.info().project.name}`
  await login(page, 'admin')
  // A host: the Config page opens on adding one.
  await goTo(page, 'Hosts')
  await page.getByRole('link', { name: 'New host' }).click()
  await expect(page.getByRole('heading', { name: 'Add a host' })).toBeVisible()
  await fits(page)
  // A service: on a host nuthatch keeps, or says there is none.
  await goTo(page, 'Services')
  await page.getByRole('link', { name: 'New service' }).click()
  await expect(page.getByRole('heading', { name: 'New service: on which host?' })).toBeVisible()
  // A host group, from the Groups page; then made on checkd, with two of its hosts.
  await page.goto('/hostgroups')
  await page.getByRole('link', { name: 'New host group' }).click()
  await expect(page.getByRole('heading', { name: 'New host group' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('select[name=backend]').selectOption('checkd')
  await expect(page.getByText('on checkd')).toBeVisible()
  await page.getByRole('button', { name: 'Add a host group' }).click()
  await page.getByLabel('Name').fill(group)
  await page.getByLabel('Alias').fill('Made from the Groups page')
  await page.getByLabel('Hosts').selectOption(['web1', 'web2'])
  await fits(page)
  await page.getByRole('button', { name: 'Save and apply' }).click()
  await expect(page.getByRole('status')).toContainText(`${group} is saved, and the engine has it.`, { timeout: 90_000 })
  expect(await livestatus('checkd', `GET hostgroups\nColumns: members\nFilter: name = ${group}`)).toEqual([[['web1', 'web2']]])
  await expect(page.locator('.managed li', { hasText: group })).toContainText('Members: web1, web2')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.locator('.managed li', { hasText: group }).getByRole('button', { name: 'Take out' }).click()
  await expect(page.getByRole('status')).toContainText(`${group} is taken out.`, { timeout: 90_000 })
})
