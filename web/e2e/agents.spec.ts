// Agents on checkd: the page makes an install command, the script it
// fetches holds what the agent needs, and the agent, run with that, joins
// the engine and shows as connected.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { fits, login } from './helpers'

const agentBinary = join(dirname(fileURLToPath(import.meta.url)), '../../../checkd/dist/agent/checkd-agent-linux-x86_64')

test('an agent installed from the Agents page joins checkd', async ({ page, request }) => {
  test.skip(!existsSync(agentBinary), "needs checkd's scripts/build-agents.sh")
  await login(page, 'admin')
  await page.goto('/agents')
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible()
  await page.getByLabel('Host').selectOption('lab2')
  await page.getByLabel('Linux').check()
  await page.getByLabel('Plugins only').uncheck()
  await page.getByRole('button', { name: 'Make command' }).click()
  const command = (await page.locator('pre.call code').textContent()) ?? ''
  expect(command).toMatch(/^curl -fsSL 'http:\/\/127\.0\.0\.1:8092\/agent\/install\/[A-Za-z0-9_-]+' \| sudo sh$/)
  await expect(page.getByRole('row', { name: /lab2/ })).toBeVisible()
  await fits(page)

  const script = await (await request.get(command.split("'")[1] ?? '')).text()
  expect(script).toContain('--engine 127.0.0.1:4731 --name lab2')
  expect((await request.get(command.split("'")[1] ?? '')).status()).toBe(404)
  const token = /printf '%s\\n' '([A-Za-z0-9_-]+)'/.exec(script)?.[1] ?? ''
  const ca = /<<'CHECKD_AGENT_CA'\n([\s\S]+?)\nCHECKD_AGENT_CA/.exec(script)?.[1] ?? ''
  expect(token).not.toBe('')
  expect(ca).toContain('BEGIN CERTIFICATE')

  const dir = mkdtempSync(join(tmpdir(), 'nuthatch-agent-'))
  writeFileSync(join(dir, 'token'), `${token}\n`)
  writeFileSync(join(dir, 'ca.crt'), `${ca}\n`)
  let agent: ChildProcess | undefined
  try {
    agent = spawn(agentBinary, ['--engine', '127.0.0.1:4731', '--name', 'lab2', '--token-file', join(dir, 'token'), '--ca', join(dir, 'ca.crt')], { stdio: 'ignore' })
    // The engine reloaded for the new token; the agent connects when it is back.
    await expect(async () => {
      await page.reload()
      await expect(page.getByRole('row', { name: /lab2/ }).getByRole('cell', { name: 'Yes' })).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30_000 })
  } finally {
    agent?.kill('SIGTERM')
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('row', { name: /lab2/ }).getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('None')).toBeVisible()
  }
})

test('the Agents page is for config_edit only', async ({ page, request }) => {
  await login(page, 'ops')
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveCount(0)
  expect((await page.request.get('/api/v1/agents/checkd')).status()).toBe(403)
  expect((await request.get('/agent/install/not-a-code')).status()).toBe(404)
})
