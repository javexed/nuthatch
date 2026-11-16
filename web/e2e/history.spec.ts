// History and availability, on a sequence of states that the
// test itself submits, on each engine, and again after the engine was
// restarted.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Page, expect, test } from '@playwright/test'
import { ENGINES, fits, livestatus, login, nextSecond, send, sleep } from './helpers'

const dev = join(dirname(fileURLToPath(import.meta.url)), '../../dev')
test.setTimeout(120_000)

/** What the server's API gives the logged-in user. */
async function api<T>(page: Page, path: string, body: unknown): Promise<T> {
  const session = (await (await page.request.get('/api/v1/session')).json()) as { csrf: string }
  const answer = await page.request.post(path, { data: body, headers: { 'X-Nuthatch-CSRF': session.csrf } })
  return (await answer.json()) as T
}

type StatsAnswer = { by_backend: Record<string, { key: string[]; values: number[] }[]> }

async function durations(page: Page, engine: string, from: number, to: number, service: string): Promise<number[]> {
  const answer = await api<StatsAnswer>(page, '/api/v1/stats', {
    table: 'statehist',
    group_by: ['host_name', 'service_description'],
    headers: [
      `Filter: time >= ${from}`, `Filter: time < ${to}`, 'Filter: host_name = passive1', `Filter: service_description = ${service}`,
      'Stats: sum duration_ok', 'Stats: sum duration_warning', 'Stats: sum duration_critical', 'Stats: sum duration_unknown',
    ],
    backends: [engine],
  })
  return answer.by_backend[engine]?.[0]?.values ?? []
}

const near = (got: number[], want: number[]) => {
  expect(got).toHaveLength(want.length)
  // Each change falls within a second of when it was sent.
  got.forEach((seconds, n) => expect(Math.abs(seconds - (want[n] ?? 0)), `state ${n}: ${got.join(',')} against ${want.join(',')}`).toBeLessThanOrEqual(1))
}

for (const engine of ENGINES) {
  test(`availability and history of a scripted sequence on ${engine}, and after its restart`, async ({ page }) => {
    await login(page, 'admin')
    // A known state before the span begins.
    await send(engine, 'PROCESS_HOST_CHECK_RESULT;passive1;0;up')
    await send(engine, 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine')
    await sleep(2500)

    // The service: OK 4 s, CRITICAL 6 s, WARNING 4 s, OK 3 s.
    // The host: up but for 5 seconds in the middle.
    const from = await nextSecond()
    await sleep(4000)
    await send(engine, 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;2;broken')
    await sleep(3000)
    await send(engine, 'PROCESS_HOST_CHECK_RESULT;passive1;1;gone')
    await sleep(3000)
    await send(engine, 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;1;slow')
    await sleep(2000)
    await send(engine, 'PROCESS_HOST_CHECK_RESULT;passive1;0;back')
    await sleep(2000)
    await send(engine, 'PROCESS_SERVICE_CHECK_RESULT;passive1;a;0;fine again')
    await sleep(3000)
    const to = from + 17

    const service = [7, 4, 6, 0]
    const host = [12, 5, 0, 0]
    near(await durations(page, engine, from, to, 'a'), service)
    near(await durations(page, engine, from, to, ''), host)

    // The page says the same.
    await page.goto(`/availability?of=services&from=${from}&to=${to}&q=passive1&backend=${engine}`)
    const row = page.locator('table.availability tbody tr', { hasText: 'passive1' }).filter({ has: page.getByRole('link', { name: 'a', exact: true }) })
    await expect(row).toHaveCount(1)
    const shown = (await row.locator('td.when').allInnerTexts()).map((text) => Number(text.replace('%', '')))
    const [ok = 0, warning = 0, critical = 0, unknown = 0] = await durations(page, engine, from, to, 'a')
    // A share is of the time the engine has a state for.
    const all = ok + warning + critical + unknown
    expect(shown[0]).toBeCloseTo((ok / all) * 100, 1)
    expect(shown[1]).toBeCloseTo((warning / all) * 100, 1)
    expect(shown[2]).toBeCloseTo((critical / all) * 100, 1)
    await fits(page)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download CSV' }).click()
    const csv = await (await download).createReadStream().then(async (stream) => {
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString()
    })
    expect(csv.split('\r\n')[0]).toContain('ok_seconds,ok_percent')
    expect(csv).toContain(`${engine},passive1,a,${from},${to},${ok},`)

    // The history, the newest first.
    await page.goto(`/history?from=${from}&to=${to + 5}&host=passive1&service=a&backend=${engine}`)
    await expect(page.locator('.events li')).toHaveCount(3)
    expect(await page.locator('.events li .badge').allInnerTexts()).toEqual(['OK', 'Warning', 'Critical'])
    await expect(page.locator('.events li').last()).toContainText('broken')
    await fits(page)
    await page.goto(`/service/${engine}/passive1/a`)
    await expect(page.locator('section.card', { has: page.getByRole('heading', { name: 'History' }) }).locator('.events li').first()).toContainText('fine again')

    // A restart of the engine loses none of it.
    execFileSync(join(dev, 'restart'), [engine])
    await expect.poll(async () => (await livestatus(engine, 'GET status\nColumns: program_start').catch(() => []))[0]?.[0] ?? 0, { timeout: 30_000 }).toBeGreaterThan(from)
    await expect.poll(() => durations(page, engine, from, to, 'a').catch(() => []), { timeout: 30_000 }).toHaveLength(4)
    near(await durations(page, engine, from, to, 'a'), service)
    near(await durations(page, engine, from, to, ''), host)
    await page.goto(`/history?from=${from}&to=${to + 5}&host=passive1&service=a&backend=${engine}`)
    await expect(page.locator('.events li')).toHaveCount(3)
  })
}

test('ops gets no history of what is not its own', async ({ page }) => {
  await login(page, 'ops')
  await page.goto('/availability?q=passive1')
  await expect(page.locator('.none', { hasText: 'None' }).first()).toBeVisible()
  await page.goto('/history?range=1h&host=passive1')
  await expect(page.locator('.none', { hasText: 'None' }).first()).toBeVisible()
  await page.goto('/availability?range=1h')
  await expect(page.locator('table.availability tbody tr')).toHaveCount(4)
  await page.goto('/history?range=1h&lines=all')
  await fits(page)
})

for (const engine of ENGINES) {
  test(`a line that is logged shows at once, on ${engine}`, async ({ page }) => {
    await login(page, 'admin')
    await page.goto(`/history?lines=notifications&backend=${engine}`)
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
    // Let the page settle on what is there already.
    await sleep(3000)
    // A notification changes no state: only the log tells of it.
    const mark = `live tail ${engine} ${Date.now()}`
    await send(engine, `SEND_CUSTOM_HOST_NOTIFICATION;web1;0;admin;${mark}`)
    // It comes without the page being asked, at the top, marked as just come.
    const line = page.locator('.events li.fresh').first()
    await expect(line).toBeVisible({ timeout: 15_000 })
    await expect(line).toContainText('web1')
    await expect(line).toContainText('to ')
    expect(await page.locator('.events li').first().evaluate((li) => li.classList.contains('fresh'))).toBe(true)
    await fits(page)
  })
}
