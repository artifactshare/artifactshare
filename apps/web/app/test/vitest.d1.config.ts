import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('..', import.meta.url)),
      '@artifactshare/contract': fileURLToPath(
        new URL('../../../../packages/contract/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['app/d1-tests/**/*.test.ts'],
    // Each test uses real Miniflare D1; some reset the server and reapply all
    // migrations, which takes several seconds on CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
