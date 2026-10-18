import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': new URL('./app', import.meta.url).pathname,
      '@artifactshare/contract': new URL(
        '../../packages/contract/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    // PDF preparation embeds this stylesheet as text, including in unit tests.
    css: { include: [/print-viewport\.css/] },
    include: [
      'app/**/*.test.ts',
      'app/**/*.test.tsx',
      'workers/**/*.test.ts',
      'vite.config.test.ts',
    ],
    exclude: ['app/**/*.browser.test.tsx', 'app/d1-tests/**/*.test.ts'],
  },
})
