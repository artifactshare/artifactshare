import { defineConfig } from 'vitest/config'
import { resolveAlias } from './resolve-alias.js'

export default defineConfig({
  resolve: { alias: resolveAlias },
  test: {
    hookTimeout: 60_000,
    testTimeout: 45_000,
    include: ['integration/**/*.test.ts'],
  },
})
