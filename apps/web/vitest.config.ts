import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': new URL('./app', import.meta.url).pathname,
    },
  },
  test: {
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx', 'workers/**/*.test.ts'],
    exclude: ['app/**/*.browser.test.tsx'],
  },
})
