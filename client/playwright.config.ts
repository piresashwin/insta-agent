/**
 * Optional Playwright config for GOLDEN=1 parity tests.
 * Only needed after: pnpm --filter client add -D @playwright/test
 */
export default {
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  use: {
    headless: true,
  },
}
