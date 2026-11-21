// Tokens on the device page: made read-only by default, shown once, and
// a read-only one reads the engines (and MCP) but sends no command.
import { expect, test } from '@playwright/test'
import { fits, login } from './helpers'

test('a read-only token is made, reads, and is deleted', async ({ page, request }, info) => {
  await login(page, 'admin')
  await page.goto('/device')
  const card = page.getByRole('region', { name: 'Tokens' })
  const name = `e2e-mcp-${info.project.name}`
  await card.getByLabel('Token name').fill(name)
  await expect(card.getByLabel('Read-only')).toBeChecked()
  await card.getByRole('button', { name: 'Make' }).click()
  const secret = (await card.locator('.made code').textContent())?.trim() ?? ''
  expect(secret).toMatch(/^nh_/)
  const row = card.getByRole('listitem').filter({ hasText: name })
  await expect(row).toContainText('read-only')
  await fits(page)

  const auth = { Authorization: `Bearer ${secret}` }
  const started = await request.post('/api/v1/mcp', { headers: auth, data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } } })
  expect(((await started.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('nuthatch')
  const read = await request.post('/api/v1/mcp', { headers: auth, data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'livestatus_query', arguments: { table: 'hosts', columns: ['name'], limit: 5 } } } })
  expect(((await read.json()) as { result: { isError: boolean } }).result.isError).toBe(false)
  const command = await request.post('/api/v1/command', { headers: auth, data: { backend: 'checkd', command: 'SCHEDULE_FORCED_HOST_CHECK', args: { host: 'gw1' } } })
  expect(command.status()).toBe(403)

  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(row).toBeHidden()
  expect((await request.post('/api/v1/mcp', { headers: auth, data: { jsonrpc: '2.0', id: 3, method: 'ping' } })).status()).toBe(401)
})
