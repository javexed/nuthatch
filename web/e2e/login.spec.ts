import { expect, test } from '@playwright/test'
import { fits, login, logout } from './helpers'

test('a wrong password says so and stays', async ({ page }) => {
  await login(page, 'admin', 'wrong')
  await expect(page.getByRole('alert')).toHaveText('wrong user or password')
  await expect(page).toHaveURL(/\/login/)
  await fits(page)
})

test('logging out ends the session', async ({ page }) => {
  await login(page, 'admin')
  await logout(page)
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/hosts')
  await expect(page).toHaveURL(/\/login\?to=\/hosts/)
})
