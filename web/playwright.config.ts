import { randomBytes } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'

// The browser tests run against a real nuthatch (dev/test-server) and
// the engines of `dev/up naemon` and `dev/up checkd`, which must be
// running. Build the interface first: pnpm build.
process.env.NUTHATCH_TEST_PASSWORD ??= randomBytes(9).toString('hex')

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8092' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 700 } } },
  ],
  webServer: {
    command: '../dev/test-server',
    url: 'http://127.0.0.1:8092/',
    reuseExistingServer: false,
    timeout: 120000,
  },
})
