// Phase 3: adding, changing and taking away a host from the interface, on
// each engine.
import { execFileSync } from 'node:child_process'
import { readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { ENGINES, fits, goTo, livestatus, login, openMore, send, sleep, chooseBackend } from './helpers'

const dev = join(dirname(fileURLToPath(import.meta.url)), '../../dev')
test.setTimeout(180_000)

// Hosts that an earlier, broken-off run added go, and the engine is told.
test.beforeAll(async () => {
  for (const engine of ENGINES) {
    const managed = join(dev, 'run', engine, 'managed')
    const left = readdirSync(managed)
    for (const file of left) unlinkSync(join(managed, file))
    if (left.length > 0) {
      execFileSync(join(dev, 'restart'), [engine])
      await sleep(3000)
    }
  }
})

for (const engine of ENGINES) {
  test(`a host is added, refused when broken, and taken out on ${engine}`, async ({ page }) => {
    const name = `ui-${engine}-${test.info().project.name}`
    const kept = `kept over the config change ${name} ${Date.now()}`
    // A downtime elsewhere, which the engine must still have afterwards.
    const start = Math.floor(Date.now() / 1000)
    await send(engine, `SCHEDULE_HOST_DOWNTIME;lab2;${start};${start + 600};1;0;0;admin;${kept}`)

    await login(page, 'admin')
    await goTo(page, 'Config')
    await expect(page.getByRole('heading', { name: 'Config' })).toBeVisible()
    await chooseBackend(page, engine)
    await page.getByRole('button', { name: 'Add a host', exact: true }).click()
    await page.getByRole('button', { name: 'Fill in the form myself' }).click()
    await page.getByLabel('Name').first().fill(name)
    await page.getByLabel('Address').fill('192.0.2.90')
    await page.getByLabel('Alias').fill('Added in the browser')
    await page.getByLabel('Host groups').selectOption(['web'])
    await page.getByRole('button', { name: 'Add a service' }).click()
    const service = page.getByRole('group', { name: 'Service 1' })
    await service.getByLabel('Name').fill('probe')
    await service.getByLabel('Check command').selectOption('demo')
    await service.getByLabel('Its arguments').fill('probe!30!0')
    await fits(page)

    await page.getByRole('button', { name: 'Check only' }).click()
    await expect(page.locator('.report')).toContainText('The engine takes this config', { timeout: 60_000 })
    await expect(page.locator('.report pre').first()).toContainText(`host_name  ${name}`)
    expect((await livestatus(engine, `GET hosts\nFilter: name = ${name}\nStats: state >= 0`))[0]?.[0]).toBe(0)

    await page.getByRole('button', { name: 'Save and apply' }).click()
    await expect(page.getByRole('status')).toContainText(`${name} is saved, and the engine has it.`, { timeout: 90_000 })
    await expect(page.locator('.managed li', { hasText: name })).toContainText('probe')
    expect(await livestatus(engine, `GET services\nColumns: host_name description host_groups\nFilter: host_name = ${name}`)).toEqual([[name, 'probe', ['web']]])
    expect((await livestatus(engine, `GET downtimes\nFilter: comment = ${kept}\nStats: id >= 0`))[0]?.[0]).toBe(1)
    await page.goto(`/host/${engine}/${name}`)
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await expect(page.locator('table.rows tbody tr')).toHaveCount(1)

    // A change the engine refuses: the name of a host it has elsewhere.
    await page.goto('/config')
    await expect(page.getByRole('heading', { name: 'Config' })).toBeVisible()
    await chooseBackend(page, engine)
    await page.locator('.managed li', { hasText: name }).getByRole('button', { name: 'Change' }).click()
    await page.getByLabel('Name').first().fill('web1')
    await page.getByRole('button', { name: 'Save and apply' }).click()
    await expect(page.locator('.report')).toContainText('Not changed: the engine does not take this config', { timeout: 60_000 })
    await expect(page.locator('.report details pre')).toContainText('web1')
    expect((await livestatus(engine, `GET hosts\nFilter: name = ${name}\nStats: state >= 0`))[0]?.[0]).toBe(1)
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Taken out again.
    page.once('dialog', (dialog) => void dialog.accept())
    await page.locator('.managed li', { hasText: name }).getByRole('button', { name: 'Take out' }).click()
    await expect(page.getByRole('status')).toContainText(`${name} is taken out.`, { timeout: 90_000 })
    await expect(page.locator('.managed li', { hasText: name })).toHaveCount(0)
    expect((await livestatus(engine, `GET hosts\nFilter: name = ${name}\nStats: state >= 0`))[0]?.[0]).toBe(0)
    expect((await livestatus(engine, `GET downtimes\nFilter: comment = ${kept}\nStats: id >= 0`))[0]?.[0]).toBe(1)
    await fits(page)
  })
}

for (const engine of ENGINES) {
  test(`a host is added by looking at it first, on ${engine}`, async ({ page }) => {
    const name = `look-${engine}-${test.info().project.name}`
    await login(page, 'admin')
    await goTo(page, 'Config')
    await chooseBackend(page, engine)
    await page.getByRole('button', { name: 'Add a host', exact: true }).click()
    // The test's own nuthatch is a web server to find.
    await page.getByLabel('Name, address or URL').fill('http://127.0.0.1:8092/')
    await page.getByRole('button', { name: 'Look' }).click()
    const http = page.locator('.suggestion').filter({ has: page.locator('.what', { hasText: /^HTTP$/ }) })
    await expect(http.first()).toBeVisible({ timeout: 30_000 })
    await expect(http.first().getByRole('checkbox')).toBeChecked()
    await expect(page.locator('.suggestion .why').first()).toContainText('the address given')
    await fits(page)
    // Only the check of the address given.
    for (const box of await page.locator('.suggestion input[type=checkbox]').all()) await box.setChecked(false)
    await http.first().getByRole('checkbox').check()
    await page.locator('.add-host').getByLabel('Name', { exact: true }).fill(name)

    await page.getByRole('button', { name: /^Add look-.* with 1 check$/ }).click()
    await expect(page.getByRole('status')).toContainText(`${name} is saved, and the engine has it.`, { timeout: 90_000 })
    expect(await livestatus(engine, `GET services\nColumns: description check_command\nFilter: host_name = ${name}`)).toEqual([['HTTP', 'nuthatch_http!8092!/']])
    // nuthatch wrote the command it brings, beside the host's file.
    expect(readdirSync(join(dev, 'run', engine, 'managed')).sort()).toContain('nuthatch-commands.cfg')

    // Looked at again: what answers there beside what is checked, and never the check it has.
    const item = page.locator('.managed li', { hasText: name })
    await item.getByRole('button', { name: 'Look again' }).click()
    const again = item.locator('.again')
    await expect(again).toContainText(/No change|New/, { timeout: 30_000 })
    await expect(again.locator('li', { hasText: /^HTTP / })).toHaveCount(0)
    await expect(again).not.toContainText('Gone')
    await fits(page)

    page.once('dialog', (dialog) => void dialog.accept())
    await page.locator('.managed li', { hasText: name }).getByRole('button', { name: 'Take out' }).click()
    await expect(page.getByRole('status')).toContainText(`${name} is taken out.`, { timeout: 90_000 })
  })
}

test('looking at a name that is not there says so', async ({ page }) => {
  await login(page, 'admin')
  await goTo(page, 'Config')
  await page.getByRole('button', { name: 'Add a host', exact: true }).click()
  await page.getByLabel('Name, address or URL').fill('no-such-host.invalid')
  await page.getByRole('button', { name: 'Look' }).click()
  await expect(page.locator('.add-host [role=alert]')).toContainText('cannot be found')
})

test('the config is not for ops', async ({ page }) => {
  await login(page, 'ops')
  await openMore(page)
  await expect(page.getByRole('link', { name: 'Config' })).toHaveCount(0)
  await page.goto('/config')
  await expect(page.getByText('Not available')).toBeVisible()
})
