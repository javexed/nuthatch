// Agents on checkd: a host is added with an agent, the install command's
// script holds what the agent needs, and the agent, run with that, joins
// the engine, says what its machine is, and the base checks follow.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { chooseBackend, fits, livestatus, login } from './helpers'

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), '../../dev/run/checkd/workers/agents')
const agentBinary = join(dirname(fileURLToPath(import.meta.url)), '../../../checkd/dist/agent/checkd-agent-linux-x86_64')

test('a host added with an agent: base checks at once, the rest proposed', async ({ page, request }) => {
  test.skip(!existsSync(agentBinary), "needs checkd's scripts/build-agents.sh")
  test.skip(test.info().project.name !== 'desktop', 'one agent is enough')
  test.setTimeout(180_000)
  const name = 'agent-e2e'
  await login(page, 'admin')
  await page.goto('/config')
  await chooseBackend(page, 'checkd')
  await page.getByRole('button', { name: 'Add a host', exact: true }).click()
  await page.getByLabel('Name, address or URL').fill('127.0.0.1')
  await page.getByRole('button', { name: 'Look' }).click()
  await page.locator('input[name=name]').fill(name, { timeout: 30_000 })
  await page.getByLabel('Linux').check()
  await expect(page.getByLabel('Install agent')).toBeChecked()
  await page.getByRole('button', { name: new RegExp(`^Add ${name}`) }).click()

  // Next, its agent: over SSH unless asked otherwise.
  const panel = page.getByRole('region', { name: `Setting up ${name}` })
  await expect(panel.getByRole('form', { name: 'Over SSH' })).toBeVisible({ timeout: 90_000 })
  await panel.getByRole('button', { name: 'Command instead' }).click()
  await panel.getByRole('button', { name: 'Make command' }).click()
  const command = (await panel.locator('pre.call code').textContent()) ?? ''
  expect(command).toMatch(/^curl -fsSL 'http:\/\/127\.0\.0\.1:8092\/agent\/install\/[A-Za-z0-9_-]+' \| sudo sh$/)
  await expect(panel.getByText('Waiting for the agent')).toBeVisible()
  await fits(page)

  const script = await (await request.get(command.split("'")[1] ?? '')).text()
  expect(script).toContain(`--engine 127.0.0.1:4731 --name ${name}`)
  expect(script).toContain('--restrict-path /usr/local/lib/checkd-agent')
  expect(script).not.toContain('monitoring-plugins')
  const token = /printf '%s\\n' '([A-Za-z0-9_-]+)'/.exec(script)?.[1] ?? ''
  const ca = /<<'CHECKD_AGENT_CA'\n([\s\S]+?)\nCHECKD_AGENT_CA/.exec(script)?.[1] ?? ''
  expect(token).not.toBe('')

  const dir = mkdtempSync(join(tmpdir(), 'nuthatch-agent-'))
  writeFileSync(join(dir, 'token'), `${token}\n`)
  writeFileSync(join(dir, 'ca.crt'), `${ca}\n`)
  let agent: ChildProcess | undefined
  try {
    agent = spawn(agentBinary, ['--engine', '127.0.0.1:4731', '--name', name, '--token-file', join(dir, 'token'), '--ca', join(dir, 'ca.crt'), '--restrict-path', join(dir, 'none')], { stdio: 'ignore' })
    // It connects, its token becomes the host's, and its inventory adds the base checks.
    await expect(panel.getByText(/^Added: Disk \//)).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByText(/Memory, Load$/)).toBeVisible()
    expect(existsSync(join(agentsDir, `${name}.token`))).toBe(true)
    const proposed = panel.getByRole('form', { name: 'Proposed checks' })
    await expect(proposed.getByText('CPU', { exact: true })).toBeVisible()
    // Only the processor.
    for (const box of await proposed.getByRole('checkbox').all()) await box.uncheck()
    await proposed.locator('input[name="proposal-cpu"]').check()
    await proposed.getByRole('button', { name: 'Add 1 check' }).click()
    await expect(proposed.getByText('CPU', { exact: true })).toHaveCount(0, { timeout: 90_000 })
    await panel.getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('.managed li', { hasText: name })).toContainText('Memory, Load, CPU')

    // Made by the agent, on its machine.
    await expect
      .poll(async () => String((await livestatus('checkd', `GET services\nColumns: plugin_output\nFilter: host_name = ${name}\nFilter: description = Memory`))[0]?.[0] ?? ''), { timeout: 90_000 })
      .toMatch(/^MEMORY (OK|WARNING|CRITICAL) - \d+% used/)
    await page.goto(`/host/checkd/${name}`)
    await expect(page.getByRole('region', { name: `Agent of ${name}` })).toContainText(/Agent( not connected)? · .+ CPU · \d+ GiB/)
  } finally {
    agent?.kill('SIGTERM')
    await page.goto('/config')
    await chooseBackend(page, 'checkd')
    const card = page.locator('.managed li', { hasText: name })
    await card.getByRole('button', { name: 'Agent' }).click()
    page.once('dialog', (dialog) => void dialog.accept())
    await card.getByRole('button', { name: 'Remove' }).click()
    await expect(card.getByRole('region', { name: `Agent of ${name}` }).getByRole('button', { name: 'Install agent' })).toBeVisible()
    page.once('dialog', (dialog) => void dialog.accept())
    await card.getByRole('button', { name: 'Take out' }).click()
    await expect(page.getByRole('status')).toContainText(`${name} is taken out.`, { timeout: 90_000 })
  }
})

test('agents are for config_edit only', async ({ page, request }) => {
  await login(page, 'ops')
  expect((await page.request.get('/api/v1/agents/checkd')).status()).toBe(403)
  expect((await request.get('/agent/install/not-a-code')).status()).toBe(404)
})
