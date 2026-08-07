import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 45_000,
    include: ['integration/**/*.test.ts'],
  },
})
