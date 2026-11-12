import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // Happy DOM uses Vite import analysis; allow the loader fixture's existing
      // explicit mock to resolve the Workers-only external module.
      name: 'unit-cloudflare-workers',
      resolveId(id) {
        return id === 'cloudflare:workers' ? `\0${id}` : null
      },
      load(id) {
        return id === '\0cloudflare:workers'
          ? 'throw new Error("cloudflare:workers requires an explicit mock in unit tests"); export const env = undefined'
          : null
      },
    },
  ],
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
    // Threads reduce full-suite runtime while retaining per-file isolation.
    pool: 'threads',
    include: [
      'app/**/*.test.ts',
      'app/**/*.test.tsx',
      'workers/**/*.test.ts',
      'vite.config.test.ts',
    ],
    exclude: ['app/**/*.browser.test.tsx', 'app/d1-tests/**/*.test.ts'],
  },
})
