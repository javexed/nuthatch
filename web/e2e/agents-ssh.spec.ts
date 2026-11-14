// An agent installed over SSH from the Agents page, into the host of
// dev/ssh-target: nuthatch logs in with a password given for that run,
// sudo takes the same password, the agent joins checkd, and its token
// becomes the host's.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { fits, login } from './helpers'

const here = dirname(fileURLToPath(import.meta.url))
const agentsDir = join(here, '../../dev/run/checkd/workers/agents')
const target = () => {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'nuthatch-ssh-target'], { encoding: 'utf8' }).trim() === 'true'
  } catch {
    return false
  }
}
const inTarget = (...command: string[]) => execFileSync('docker', ['exec', 'nuthatch-ssh-target', ...command], { encoding: 'utf8' })

test('an agent installed over SSH, with a password for that run alone', async ({ page }) => {
  test.skip(!target(), 'needs dev/ssh-target')
  test.skip(test.info().project.name !== 'desktop', 'one install is enough')
  test.setTimeout(120_000)
  await login(page, 'admin')
  await page.goto('/agents')
  await page.getByLabel('Host').selectOption('lab2')
  await page.getByLabel('Plugins only').uncheck()
  await page.getByLabel('Over SSH').check()
  const form = page.getByRole('form', { name: 'Over SSH' })
  await form.getByLabel('SSH address').fill('127.0.0.1')
  await form.getByLabel('Port').fill('2222')
  await form.getByLabel('User').fill('admin')

  // A wrong password: refused, and nothing changes on the host.
  await form.getByRole('button', { name: 'Look up host key' }).click()
  await expect(form.getByText(/ssh-ed25519 SHA256:/)).toBeVisible()
  await form.locator('input[name=ssh-password]').fill('wrong-pass')
  await form.getByRole('button', { name: 'Install' }).click()
  await expect(form.locator('input[name=ssh-password]')).toHaveValue('')
  const result = page.getByRole('region', { name: 'Install over SSH' })
  await expect(result.getByRole('status')).toHaveText('Failed', { timeout: 30_000 })
  await expect(result).toContainText('Permission denied')
  await expect(result).not.toContainText('wrong-pass')

  // The right one: installed, joined, and the token is the host's.
  await form.locator('input[name=ssh-password]').fill('admin-pass')
  await form.getByRole('button', { name: 'Install' }).click()
  await expect(result.getByRole('status')).toHaveText('Done', { timeout: 90_000 })
  await expect(result).toContainText('checkd-agent runs for lab2')
  await expect(result).not.toContainText('admin-pass')
  expect(inTarget('systemctl', 'is-active', 'checkd-agent').trim()).toBe('active')
  await expect.poll(() => existsSync(join(agentsDir, 'lab2.token')), { timeout: 20_000 }).toBe(true)
  await expect(async () => {
    await page.reload()
    await expect(page.getByRole('row', { name: /lab2/ }).getByRole('cell', { name: 'Yes' })).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 30_000 })
  await fits(page)

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('row', { name: /lab2/ }).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('None')).toBeVisible()
  inTarget('systemctl', 'disable', '--now', 'checkd-agent')
})

test('over SSH with a key and its passphrase, sudo by its own password', async ({ page }) => {
  test.skip(!target(), 'needs dev/ssh-target')
  test.skip(test.info().project.name !== 'desktop', 'one install is enough')
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'nuthatch-ssh-key-'))
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'key-pass', '-C', 'e2e', '-f', join(dir, 'id')])
  const pub = readFileSync(join(dir, 'id.pub'), 'utf8').trim()
  inTarget('sh', '-c', `mkdir -p /home/admin/.ssh && echo '${pub}' > /home/admin/.ssh/authorized_keys && chown -R admin /home/admin/.ssh && chmod 600 /home/admin/.ssh/authorized_keys`)
  await login(page, 'admin')
  await page.goto('/agents')
  await page.getByLabel('Host').selectOption('lab2')
  await page.getByLabel('Plugins only').uncheck()
  await page.getByLabel('Over SSH').check()
  const form = page.getByRole('form', { name: 'Over SSH' })
  await form.getByLabel('SSH address').fill('127.0.0.1')
  await form.getByLabel('Port').fill('2222')
  await form.getByLabel('User').fill('admin')
  await form.getByLabel('Key', { exact: true }).check()
  await form.getByLabel('Private key').fill(readFileSync(join(dir, 'id'), 'utf8'))
  await form.getByLabel('Passphrase').fill('key-pass')
  await form.getByLabel('sudo password').fill('admin-pass')
  await form.getByRole('button', { name: 'Look up host key' }).click()
  await form.getByRole('button', { name: 'Install' }).click()
  await expect(form.getByLabel('Private key')).toHaveValue('')
  const result = page.getByRole('region', { name: 'Install over SSH' })
  await expect(result.getByRole('status')).toHaveText('Done', { timeout: 90_000 })
  await expect(result).toContainText('checkd-agent runs for lab2')
  await expect(result).not.toContainText('PRIVATE KEY')
  await expect.poll(() => existsSync(join(agentsDir, 'lab2.token')), { timeout: 20_000 }).toBe(true)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()
  await page.getByRole('row', { name: /lab2/ }).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('None')).toBeVisible()
  inTarget('systemctl', 'disable', '--now', 'checkd-agent')
  inTarget('rm', '-f', '/home/admin/.ssh/authorized_keys')
})
