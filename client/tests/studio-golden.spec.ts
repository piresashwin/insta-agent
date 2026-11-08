/**
 * Golden client↔server PNG parity (Playwright entrypoint).
 *
 * Gated by GOLDEN=1 so default CI without a browser still passes.
 * The primary pixel-diff assertion lives in:
 *   server/src/render/__tests__/golden-parity.test.ts
 *
 * Setup (once):
 *   pnpm --filter server add -D playwright
 *   npx playwright install chromium
 *
 * Run:
 *   GOLDEN=1 pnpm --filter server test:golden
 *
 * This file is intentionally import-light so the client package does not
 * require @playwright/test unless you add a local Playwright project.
 */

import { test, expect } from 'node:test'

const runGolden = process.env.GOLDEN === '1'

test(
  'studio golden parity is gated by GOLDEN=1 (see server golden-parity.test.ts)',
  { skip: !runGolden },
  async () => {
    // When GOLDEN=1, the real browser↔server comparison is the server suite.
    // Keep this node:test stub so the file is executable without Playwright deps.
    expect(process.env.GOLDEN).toBe('1')
  },
)
