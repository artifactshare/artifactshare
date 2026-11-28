import { defineConfig } from 'vitest/config'
import { resolveAlias } from '../../resolve-alias.js'

export default defineConfig({
  resolve: { alias: resolveAlias },
  test: {
    include: ['app/d1-tests/**/*.test.ts'],
    // Each test uses real Miniflare D1; some reset the server and reapply all
    // migrations, which takes several seconds on CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
