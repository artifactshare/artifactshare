import {
  sandboxHashDocument,
  sandboxHashDocumentLoads,
} from './app/test/sandbox-hash-browser-command'
import { cspDiagnostic } from './app/test/csp-diagnostic-browser-command'
import {
  staticSiteExtensions,
  staticSiteXmlEmbedding,
  staticSiteWasm,
} from './app/test/static-site-wasm-browser-command'
import { selectAnchorText } from './app/test/anchor-browser-command'
import { resolve } from 'node:path'
import { playwright } from '@vitest/browser-playwright'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'node_modules/.vite-browser-behavior',
  optimizeDeps: { include: ['mermaid', 'react-dom/server'] },
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
      provider: playwright(),
      commands: {
        selectAnchorText,
        staticSiteWasm,
        staticSiteExtensions,
        staticSiteXmlEmbedding,
        cspDiagnostic,
        sandboxHashDocument,
        sandboxHashDocumentLoads,
      },
      headless: true,
      instances: [
        { browser: 'chromium' },
        {
          browser: 'firefox',
          include: [
            'app/lib/*anchor*.behavior.browser.test.tsx',
            'app/lib/csp-reporter.behavior.browser.test.tsx',
            'app/routes/comment-frame-recovery.behavior.browser.test.tsx',
            'app/routes/sandbox-frame-recovery.behavior.browser.test.tsx',
            'app/routes/a.$id/viewer-revisit.behavior.browser.test.tsx',
            'app/routes/a.$id/hash-sync.behavior.browser.test.tsx',
          ],
        },
        {
          browser: 'webkit',
          include: [
            'app/lib/*anchor*.behavior.browser.test.tsx',
            'app/lib/csp-reporter.behavior.browser.test.tsx',
            'app/routes/comment-frame-recovery.behavior.browser.test.tsx',
            'app/routes/sandbox-frame-recovery.behavior.browser.test.tsx',
            'app/routes/a.$id/viewer-revisit.behavior.browser.test.tsx',
            'app/routes/a.$id/hash-sync.behavior.browser.test.tsx',
          ],
        },
      ],
      fileParallelism: false,
    },
  },
})
