import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['app/d1-tests/**/*.test.ts'],
  },
})
