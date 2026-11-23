// An agent installed over SSH from a host's page, into the host of
// dev/ssh-target: nuthatch logs in with a password given for that run,
// sudo takes the same password, the agent joins checkd, and its token
// becomes the host's.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { chooseBackend, fits, livestatus, login, send } from './helpers'

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

/**
 * No agent of lab2 before a test or after one, passed or failed: one left
 * running, or a token left in checkd's agents directory, would make the
 * next run start from an agent that is already there.
 */
async function reset() {
  if (!target()) return
  try {
    inTarget('systemctl', 'disable', '--now', 'checkd-agent')
  } catch {
    // Never installed.
  }
  inTarget('rm', '-f', '/home/admin/.ssh/authorized_keys')
  const tokens = ['lab2.token', 'lab2.new'].map((name) => join(agentsDir, name)).filter((path) => existsSync(path))
  if (tokens.length === 0) return
  for (const path of tokens) rmSync(path, { force: true })
  // checkd forgets the agent when it reads its configuration again.
  const before = (await livestatus('checkd', 'GET status\nColumns: program_start'))[0]?.[0] as number
  await send('checkd', 'RESTART_PROGRAM')
  await expect
    .poll(async () => ((await livestatus('checkd', 'GET status\nColumns: program_start').catch(() => []))[0]?.[0] as number) ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(before)
}

// The tests run on the desktop project only.
test.beforeEach(async ({ page: _ }, info) => {
  if (info.project.name === 'desktop') await reset()
})
test.afterEach(async ({ page: _ }, info) => {
  if (info.project.name === 'desktop') await reset()
})

test('an agent installed over SSH, with a password for that run alone', async ({ page }) => {
  test.skip(!target(), 'needs dev/ssh-target')
  test.skip(test.info().project.name !== 'desktop', 'one install is enough')
  test.setTimeout(120_000)
  await login(page, 'admin')
  await page.goto('/host/checkd/lab2')
  const agent = page.getByRole('region', { name: 'Agent of lab2' })
  await agent.getByRole('button', { name: 'Install agent' }).click()
  const form = agent.getByRole('form', { name: 'Over SSH' })
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
  await expect(result.getByRole('status')).toHaveText('Installed', { timeout: 90_000 })
  await expect(result).toContainText('checkd-agent runs for lab2')
  await expect(result).not.toContainText('admin-pass')
  expect(inTarget('systemctl', 'is-active', 'checkd-agent').trim()).toBe('active')
  await expect.poll(() => existsSync(join(agentsDir, 'lab2.token')), { timeout: 20_000 }).toBe(true)
  // lab2 is not in nuthatch's config: its inventory is shown, nothing added.
  await expect(agent).toContainText(/Agent · Debian/, { timeout: 30_000 })
  await fits(page)

  page.once('dialog', (dialog) => void dialog.accept())
  await agent.getByRole('button', { name: 'Remove' }).click()
  await expect(agent.getByRole('button', { name: 'Install agent' })).toBeVisible()
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
  await page.goto('/host/checkd/lab2')
  const agent = page.getByRole('region', { name: 'Agent of lab2' })
  await agent.getByRole('button', { name: 'Install agent' }).click()
  const form = agent.getByRole('form', { name: 'Over SSH' })
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
  await expect(result.getByRole('status')).toHaveText('Installed', { timeout: 90_000 })
  await expect(result).toContainText('checkd-agent runs for lab2')
  await expect(result).not.toContainText('PRIVATE KEY')
  await expect.poll(() => existsSync(join(agentsDir, 'lab2.token')), { timeout: 20_000 }).toBe(true)
  await expect(agent.getByText(/^Agent/)).toBeVisible({ timeout: 30_000 })
  page.once('dialog', (dialog) => void dialog.accept())
  await agent.getByRole('button', { name: 'Remove' }).click()
  await expect(agent.getByRole('button', { name: 'Install agent' })).toBeVisible()
  inTarget('systemctl', 'disable', '--now', 'checkd-agent')
  inTarget('rm', '-f', '/home/admin/.ssh/authorized_keys')
})

test('an agent replaces itself when asked, as its own user', async ({ page }) => {
  test.skip(!target(), 'needs dev/ssh-target')
  test.skip(test.info().project.name !== 'desktop', 'one install is enough')
  test.setTimeout(300_000)
  await login(page, 'admin')
  await page.goto('/host/checkd/lab2')
  const agent = page.getByRole('region', { name: 'Agent of lab2' })
  await agent.getByRole('button', { name: 'Install agent' }).click()
  const form = agent.getByRole('form', { name: 'Over SSH' })
  await form.getByLabel('SSH address').fill('127.0.0.1')
  await form.getByLabel('Port').fill('2222')
  await form.getByLabel('User').fill('admin')
  await form.getByRole('button', { name: 'Look up host key' }).click()
  await form.locator('input[name=ssh-password]').fill('admin-pass')
  await form.getByRole('button', { name: 'Install' }).click()
  const result = page.getByRole('region', { name: 'Install over SSH' })
  await expect(result.getByRole('status')).toHaveText('Installed', { timeout: 90_000 })
  await expect.poll(() => existsSync(join(agentsDir, 'lab2.token')), { timeout: 20_000 }).toBe(true)
  // Its version, from its inventory.
  await expect(agent).toContainText(/Agent · Debian.*GiB\s· \d+\.\d+\.\d+/, { timeout: 30_000 })

  // The binary is the agent's user's, and differs now from what nuthatch serves.
  const bin = '/var/lib/checkd-agent/bin/checkd-agent'
  expect(inTarget('stat', '-c', '%U', bin).trim()).toBe('checkd-agent')
  inTarget('sh', '-c', `cp ${bin} /tmp/older && printf x >> /tmp/older && install -o checkd-agent -m 755 /tmp/older ${bin} && systemctl restart checkd-agent`)
  const served = readFileSync(join(here, '../../dev/run/checkd/agent-bin/SHA256SUMS'), 'utf8').match(/^([0-9a-f]{64}) +checkd-agent-linux-x86_64$/m)?.[1]
  const have = () => inTarget('sha256sum', bin).split(' ')[0]
  expect(have()).not.toBe(served)

  // As Update on the page does; the page shows it only for an older version.
  const { csrf } = (await (await page.request.get('/api/v1/session')).json()) as { csrf: string }
  const asked = await page.request.post('/api/v1/agents/checkd/lab2/update', { headers: { 'X-Nuthatch-CSRF': csrf }, data: {} })
  expect(asked.status()).toBe(200)
  // It asks within a minute and a half of its start.
  await expect.poll(have, { timeout: 150_000, intervals: [5000] }).toBe(served)
  await expect.poll(() => inTarget('journalctl', '-u', 'checkd-agent', '--no-pager', '-n', '50'), { timeout: 30_000 }).toContain('Updated:')
  // Started again by systemd, after its RestartSec.
  const active = () => {
    try {
      return inTarget('systemctl', 'is-active', 'checkd-agent').trim()
    } catch {
      return 'not yet'
    }
  }
  await expect.poll(active, { timeout: 30_000 }).toBe('active')
  // And it connects again, as the new one.
  await expect.poll(() => inTarget('journalctl', '-u', 'checkd-agent', '--no-pager', '-n', '5'), { timeout: 30_000 }).toMatch(/Updated:[\s\S]*Connected to/)
  expect(inTarget('ps', '-o', 'user=', '-C', 'checkd-agent').trim()).toBe('checkd-agent')
  expect(inTarget('stat', '-c', '%U', bin).trim()).toBe('checkd-agent')

  // Installed again over SSH, over the agent it has: the way for an agent
  // that does not ask.
  inTarget('sh', '-c', `install -o checkd-agent -m 755 /tmp/older ${bin} && systemctl restart checkd-agent`)
  const token = readFileSync(join(agentsDir, 'lab2.token'), 'utf8')
  await agent.getByRole('button', { name: 'Install again' }).click()
  await form.getByLabel('SSH address').fill('127.0.0.1')
  await form.getByLabel('Port').fill('2222')
  await form.getByLabel('User').fill('admin')
  await form.getByRole('button', { name: 'Look up host key' }).click()
  await form.locator('input[name=ssh-password]').fill('admin-pass')
  await form.getByRole('button', { name: 'Install' }).click()
  await expect(result.getByRole('status')).toHaveText('Installed', { timeout: 90_000 })
  expect(have()).toBe(served)
  await agent.getByRole('button', { name: 'Close' }).click()
  await expect(form).toHaveCount(0)
  await expect.poll(() => readFileSync(join(agentsDir, 'lab2.token'), 'utf8'), { timeout: 20_000 }).not.toBe(token)
  await expect(agent).not.toContainText('not connected', { timeout: 30_000 })

  page.once('dialog', (dialog) => void dialog.accept())
  await agent.getByRole('button', { name: 'Remove' }).click()
  await expect(agent.getByRole('button', { name: 'Install agent' })).toBeVisible()
})

test('an agent installed with a signing key takes only binaries it signed later, and goes back from one that does not connect', async ({ page }) => {
  test.skip(!target(), 'needs dev/ssh-target')
  test.skip(test.info().project.name !== 'desktop', 'one install is enough')
  test.setTimeout(600_000)
  await login(page, 'admin')
  const { csrf } = (await (await page.request.get('/api/v1/session')).json()) as { csrf: string }
  const headers = { 'X-Nuthatch-CSRF': csrf }
  const signedAt = async () => {
    const answer = await page.request.post('/api/v1/agent-signing/sign', { headers })
    expect(answer.status()).toBe(200)
    return Math.floor(((await answer.json()) as { signed: { at: number } }).signed.at / 1000)
  }
  expect((await page.request.put('/api/v1/agent-signing/key', { headers, data: { make: true } })).status()).toBe(200)
  try {
    const first = await signedAt()
    await page.goto('/config')
    await chooseBackend(page, 'checkd')
    await expect(page.getByRole('region', { name: 'Agent signing' })).toContainText(/nuthatch agent signing Ed25519 .* self-signed/)
    await expect(page.getByRole('region', { name: 'Agent signing' })).toContainText('Signed')

    await page.goto('/host/checkd/lab2')
    const agent = page.getByRole('region', { name: 'Agent of lab2' })
    await agent.getByRole('button', { name: 'Install agent' }).click()
    const form = agent.getByRole('form', { name: 'Over SSH' })
    await form.getByLabel('SSH address').fill('127.0.0.1')
    await form.getByLabel('Port').fill('2222')
    await form.getByLabel('User').fill('admin')
    await form.getByRole('button', { name: 'Look up host key' }).click()
    await form.locator('input[name=ssh-password]').fill('admin-pass')
    await form.getByRole('button', { name: 'Install' }).click()
    await expect(page.getByRole('region', { name: 'Install over SSH' }).getByRole('status')).toHaveText('Installed', { timeout: 90_000 })
    await expect.poll(() => existsSync(join(agentsDir, 'lab2.token')), { timeout: 20_000 }).toBe(true)
    const bin = '/var/lib/checkd-agent/bin/checkd-agent'
    expect(inTarget('cat', '/etc/systemd/system/checkd-agent.service')).toContain('--update-signer /etc/checkd-agent/signer.crt')
    expect(inTarget('cat', `${bin}.signed`).trim()).toBe(String(first))
    const journal = () => inTarget('journalctl', '-u', 'checkd-agent', '--no-pager', '-n', '30')

    // Another binary than it is served, and the one served signed no later
    // than its own: refused.
    const served = readFileSync(join(here, '../../dev/run/checkd/agent-bin/SHA256SUMS'), 'utf8').match(/^([0-9a-f]{64}) +checkd-agent-linux-x86_64$/m)?.[1]
    const have = () => inTarget('sha256sum', bin).split(' ')[0]
    inTarget('sh', '-c', `cp ${bin} /tmp/older && printf x >> /tmp/older && install -o checkd-agent -m 755 /tmp/older ${bin} && systemctl restart checkd-agent`)
    const older = have()
    expect((await page.request.post('/api/v1/agents/checkd/lab2/update', { headers, data: {} })).status()).toBe(200)
    await expect.poll(journal, { timeout: 150_000, intervals: [5000] }).toContain('signed before the one this agent has')
    expect(have()).toBe(older)

    // Signed again, later: taken, and kept once it connects.
    const second = await signedAt()
    inTarget('systemctl', 'restart', 'checkd-agent')
    await expect.poll(have, { timeout: 150_000, intervals: [5000] }).toBe(served)
    await expect.poll(journal, { timeout: 60_000 }).toContain('this binary connected, and stays')
    expect(inTarget('cat', `${bin}.signed`).trim()).toBe(String(second))
    expect(inTarget('sh', '-c', `ls ${bin}.old ${bin}.trial 2>/dev/null || true`).trim()).toBe('')

    // A binary on trial that cannot reach the engine, started three times:
    // the one before it is put back, and the one on trial refused.
    inTarget('sh', '-c', `install -o checkd-agent -m 755 /tmp/older ${bin}.old && echo "$(date +%s) 0 ${served}" > ${bin}.trial && chown checkd-agent ${bin}.trial`)
    inTarget('sh', '-c', "cp /etc/systemd/system/checkd-agent.service /tmp/unit && sed -i 's/--engine [^ ]*/--engine 127.0.0.1:9/' /etc/systemd/system/checkd-agent.service && systemctl daemon-reload")
    for (let n = 0; n < 4; n++) {
      inTarget('systemctl', 'restart', 'checkd-agent')
      await page.waitForTimeout(2000)
    }
    await expect.poll(have, { timeout: 30_000 }).toBe(older)
    expect(journal()).toContain('went back to the one before')
    expect(inTarget('cat', `${bin}.refused`)).toContain(served)
    inTarget('sh', '-c', 'cp /tmp/unit /etc/systemd/system/checkd-agent.service && systemctl daemon-reload && systemctl restart checkd-agent')
    // It says so when it asks, and is not given that binary again.
    await expect(agent).toContainText('went back from', { timeout: 150_000 })
    expect(have()).toBe(older)

    page.once('dialog', (dialog) => void dialog.accept())
    await agent.getByRole('button', { name: 'Remove' }).click()
    await expect(agent.getByRole('button', { name: 'Install agent' })).toBeVisible()
  } finally {
    await page.request.delete('/api/v1/agent-signing/key', { headers })
  }
})
