import { playwright } from '@vitest/browser-playwright'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'
import { resolveAlias } from './resolve-alias.js'

export default defineConfig({
  cacheDir: 'node_modules/.vite-browser-visual',
  define: {
    __VISUAL_FAULT__: JSON.stringify(process.env.VISUAL_FAULT ?? null),
  },
  resolve: { alias: resolveAlias },
  plugins: [
    tailwindcss(),
    {
      name: 'visual-cloudflare-workers',
      resolveId(id) {
        return id === 'cloudflare:workers' ? `\0${id}` : null
      },
      load(id) {
        return id === '\0cloudflare:workers' ? 'export const env = {}' : null
      },
    },
  ],
  test: {
    fileParallelism: false,
    include: [
      'app/**/*.browser.test.tsx',
      '!app/**/*.behavior.browser.test.tsx',
    ],
    api: { host: '127.0.0.1' },
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: !process.env.VISUAL_FAULT,
      instances: [{ browser: 'chromium' }],
      expect: {
        toMatchScreenshot: {
          resolveScreenshotPath: ({
            arg,
            browserName,
            ext,
            root,
            screenshotDirectory,
            testFileDirectory,
            testFileName,
          }) =>
            `${root}/${testFileDirectory}/${screenshotDirectory}/${testFileName}/${arg}-${browserName}${ext}`,
        },
      },
    },
  },
})
