import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    hookTimeout: 60_000,
    testTimeout: 45_000,
    include: ['integration/**/*.test.ts'],
  },
})
