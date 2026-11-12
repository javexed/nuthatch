import { expect, type Page, test } from '@playwright/test'

const password = process.env.NUTHATCH_TEST_PASSWORD ?? ''

async function login(page: Page, user: string, pass = password) {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('User').fill(user)
  await page.getByLabel('Password').fill(pass)
  await page.getByRole('button', { name: 'Log in' }).click()
}

function hostTotals(page: Page) {
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hosts', exact: true }) })
  return section.locator('li strong')
}

/** The page must not scroll sideways, whatever the width. */
async function fits(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(wider).toBeLessThanOrEqual(0)
}

test('a wrong password says so and stays', async ({ page }) => {
  await login(page, 'admin', 'wrong')
  await expect(page.getByRole('alert')).toHaveText('wrong user or password')
  await expect(page).toHaveURL(/\/login/)
  await fits(page)
})

test('admin sees the totals of every host and service of both engines', async ({ page }) => {
  await login(page, 'admin')
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
  const hosts = hostTotals(page)
  // Ten hosts on each of the two engines.
  await expect.poll(async () => (await hosts.allInnerTexts()).reduce((sum, n) => sum + Number(n), 0)).toBe(20)
  await expect(page.locator('.backends li', { hasText: 'naemon' })).toContainText('answering')
  await fits(page)
})

test('ops sees only its own, and is told which engine is closed to it', async ({ page }) => {
  await login(page, 'ops')
  const hosts = hostTotals(page)
  const total = async () => (await hosts.allInnerTexts()).reduce((sum, n) => sum + Number(n), 0)
  // web1 and web2 on Naemon. checkd does not limit users yet, so it is
  // closed to ops; once it does, this becomes 4.
  await expect.poll(total).toBe(2)
  await expect(page.locator('.backends li', { hasText: 'checkd' })).toContainText('does not limit')
  await fits(page)
})

test('logging out ends the session', async ({ page }) => {
  await login(page, 'admin')
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})
