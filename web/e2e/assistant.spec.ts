// The assistant: hidden until a key is set, for the users it is for; a
// question from a host's or service's page carries that page. The model
// itself is not asked: its answer is played back as the server sends it.
import { type Page, expect, test } from '@playwright/test'
import { fits, goTo, login, logout, send } from './helpers'

/** Answers every question with these events, as the server's stream does. */
async function answers(page: Page, events: Record<string, unknown>[]) {
  const asked: Record<string, unknown>[] = []
  await page.route('**/api/v1/assistant', async (route) => {
    asked.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: events.map((e) => `event: ${String(e.kind)}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    })
  })
  return asked
}

test('is offered once a key is set, and answers beside the page', async ({ page }) => {
  await login(page, 'admin')
  const open = page.getByRole('button', { name: 'Assistant' })
  // A key may be left from the other project's run: start without one.
  await goTo(page, 'Config')
  const card = page.getByRole('form', { name: 'Assistant' })
  await expect(card).toBeVisible()
  // Settings may be left from another run: on, Anthropic, no key.
  if (!(await card.getByLabel('On').isChecked())) {
    await card.getByLabel('On').check()
    await card.getByLabel('Who may use it').fill('admin, ops')
    await card.getByLabel('Service').selectOption('anthropic')
    await card.getByLabel('Model').fill('claude-opus-5-5')
    await card.getByLabel('API key').fill('e2e-key-not-real-0000000000')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(open).toBeVisible()
  }
  if ((await card.getByLabel('Service').inputValue()) !== 'anthropic') {
    await card.getByLabel('Service').selectOption('anthropic')
    await card.getByLabel('Model').fill('claude-opus-5-5')
    await card.getByLabel('API key').fill('e2e-key-not-real-0000000000')
    await card.getByRole('button', { name: 'Save' }).click()
  }
  if (await card.getByRole('button', { name: 'Remove key' }).isVisible()) await card.getByRole('button', { name: 'Remove key' }).click()
  await expect(card.getByRole('button', { name: 'Remove key' })).toBeHidden()
  await expect(open).toBeHidden()

  await card.getByLabel('API key').fill('e2e-key-not-real-0000000000')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByLabel('API key')).toHaveAttribute('placeholder', 'kept')
  await expect(open).toBeVisible()

  const asked = await answers(page, [
    { kind: 'tool', text: 'services: state > 0' },
    { kind: 'text', text: 'Nothing is critical.\n- ping on gw1 is fine' },
    { kind: 'done', steps: 2 },
  ])
  await open.click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  await panel.getByLabel('Question').fill('anything wrong?')
  await panel.getByLabel('Question').press('Enter')
  await expect(panel.getByText('services: state > 0')).toBeVisible()
  await expect(panel.getByText('Nothing is critical.')).toBeVisible()
  expect(asked[0]).toEqual({ turns: [{ role: 'user', text: 'anything wrong?' }] })
  await fits(page)

  // The next question carries the conversation.
  await panel.getByLabel('Question').fill('and gw1?')
  await panel.getByRole('button', { name: 'Ask' }).click()
  await expect.poll(() => asked.length).toBe(2)
  expect((asked[1]?.turns as unknown[]).length).toBe(3)
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).toBeHidden()
})

test('explains a problem from its page', async ({ page }) => {
  await login(page, 'admin')
  await goTo(page, 'Config')
  const card = page.getByRole('form', { name: 'Assistant' })
  await expect(card).toBeVisible()
  if (!(await card.getByRole('button', { name: 'Remove key' }).isVisible())) {
    await card.getByLabel('API key').fill('e2e-key-not-real-0000000000')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card.getByRole('button', { name: 'Remove key' })).toBeVisible()
  }
  await send('checkd', `PROCESS_SERVICE_CHECK_RESULT;gw1;ping;2;CRITICAL - e2e assistant`)
  const asked = await answers(page, [
    { kind: 'text', text: 'ping on gw1 was set critical by hand.' },
    { kind: 'done', steps: 1 },
  ])
  await page.goto('/service/checkd/gw1/ping')
  const explain = page.getByRole('button', { name: 'Explain' })
  await expect(explain).toBeVisible({ timeout: 20_000 })
  await explain.click()
  const panel = page.getByRole('complementary', { name: 'Assistant' })
  await expect(panel.getByText('ping on gw1 was set critical by hand.')).toBeVisible()
  expect(asked[0]?.about).toEqual({ backend: 'checkd', host: 'gw1', service: 'ping' })
  await fits(page)
})

test('asks for what each service needs', async ({ page }) => {
  await login(page, 'admin')
  await goTo(page, 'Config')
  const card = page.getByRole('form', { name: 'Assistant' })
  // Off shows nothing more; on shows the rest.
  await expect(card.getByLabel('On')).toBeChecked()
  await card.getByLabel('On').uncheck()
  await expect(card.getByLabel('Service')).toBeHidden()
  await expect(card.getByLabel('Who may use it')).toBeHidden()
  await card.getByLabel('On').check()
  await expect(card.getByLabel('Who may use it')).toHaveValue(/admin/)
  await card.getByLabel('Service').selectOption('ollama')
  await expect(card.getByLabel('Address')).toHaveAttribute('placeholder', 'http://127.0.0.1:11434')
  await expect(card.getByLabel('Context')).toBeVisible()
  await expect(card.getByLabel('Effort')).toBeHidden()
  // A local model needs no key.
  await expect(card.getByLabel('API key')).not.toHaveAttribute('required', '')
  await card.getByLabel('Service').selectOption('openai')
  await expect(card.getByLabel('Context')).toBeHidden()
  await card.getByLabel('Service').selectOption('anthropic')
  await expect(card.getByLabel('Effort')).toBeVisible()
  await fits(page)
})

test('is not offered to whom it is not for', async ({ page }) => {
  await login(page, 'viewer')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Assistant' })).toBeHidden()
  await logout(page)
  await login(page, 'ops')
  // ops may use it but not set its key; a key is set by the tests above.
  await expect(page.getByRole('button', { name: 'Assistant' })).toBeVisible()
})
