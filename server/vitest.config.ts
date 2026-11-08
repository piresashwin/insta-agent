import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'evals/**/*.test.ts'],
    // Avoid loading the full DB on import — tests that need DB set up their own
    testTimeout: 15_000,
  },
})
