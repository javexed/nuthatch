import { expect, test } from '@playwright/test'
import { fits, goTo, login, logout } from './helpers'

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

test('this device: where notifications are turned on', async ({ page }) => {
  await login(page, 'admin')
  await goTo(page, test.info().project.name === 'phone' ? 'This device' : 'admin')
  await expect(page.getByRole('heading', { name: 'This device' })).toBeVisible()
  const box = page.getByRole('region', { name: 'Notifications' })
  await expect(box).toContainText('None')
  await fits(page)
})

test('this device: a theme, kept and drawn before the page', async ({ page }) => {
  await login(page, 'admin')
  await goTo(page, test.info().project.name === 'phone' ? 'This device' : 'admin')
  const themes = page.getByRole('radiogroup', { name: 'Theme' })
  await expect(themes.getByRole('radio', { name: 'System' })).toBeChecked()
  await fits(page)
  await themes.getByText('Night').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0c0e11')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'night')
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Night' })).toBeChecked()
  await page.getByRole('radiogroup', { name: 'Theme' }).getByText('System').click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 246, 248)')
})
