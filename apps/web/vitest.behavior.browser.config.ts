import { resolve } from 'node:path'
import { playwright } from '@vitest/browser-playwright'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'node_modules/.vite-browser-behavior',
  resolve: { alias: { '~': resolve(import.meta.dirname, 'app') } },
  plugins: [
    tailwindcss(),
    {
      name: 'browser-behavior-cloudflare-workers',
      resolveId(id) {
        return id === 'cloudflare:workers' ? `\0${id}` : null
      },
      load(id) {
        return id === '\0cloudflare:workers' ? 'export const env = {}' : null
      },
    },
  ],
  test: {
    include: ['app/**/*.behavior.browser.test.tsx'],
    api: { host: '127.0.0.1' },
    browser: {
      enabled: true,
      provider: playwright(
        process.env.CI ? { launchOptions: { channel: 'chrome' } } : undefined,
      ),
      headless: true,
      instances: [{ browser: 'chromium' }],
      fileParallelism: false,
    },
  },
})
