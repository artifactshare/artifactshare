import { previewSecurity } from './app/test/preview-security-browser-command'
import { usercontentDelivery } from './app/test/usercontent-browser-command'
import {
  sandboxHashDocument,
  sandboxHashDocumentLoads,
} from './app/test/sandbox-hash-browser-command'
import { cspDiagnostic } from './app/test/csp-diagnostic-browser-command'
import { pdfViewerScenario } from './app/test/pdf-viewer-browser-command'
import { videoViewerScenario } from './app/test/video-viewer-browser-command'
import {
  staticSiteExtensions,
  staticSiteXmlEmbedding,
  staticSiteWasm,
} from './app/test/static-site-wasm-browser-command'
import {
  setMermaidColorScheme,
  setReducedMotion,
} from './app/test/mermaid-browser-command'
import { selectAnchorText } from './app/test/anchor-browser-command'
import {
  staticSiteCommentSite,
  staticSiteFrame,
} from './app/test/static-site-comment-browser-command'
import {
  projectPlacementDestinations,
  projectPlacementCandidates,
} from './app/test/project-placement-browser-command'
import { resolve } from 'node:path'
import { playwright } from '@vitest/browser-playwright'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: 'node_modules/.vite-browser-behavior',
  optimizeDeps: {
    include: [
      '@mozilla/readability',
      'dompurify',
      'mermaid',
      'react-dom/server',
      'turndown',
    ],
  },
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
      provider: playwright({ contextOptions: { locale: 'en-US' } }),
      commands: {
        previewSecurity,
        usercontentDelivery,
        projectPlacementDestinations,
        projectPlacementCandidates,
        selectAnchorText,
        staticSiteCommentSite,
        staticSiteFrame,
        setMermaidColorScheme,
        setReducedMotion,
        staticSiteWasm,
        staticSiteExtensions,
        staticSiteXmlEmbedding,
        cspDiagnostic,
        pdfViewerScenario,
        videoViewerScenario,
        sandboxHashDocument,
        sandboxHashDocumentLoads,
      },
      headless: true,
      instances: [
        {
          browser: 'chromium',
          // A sandboxed agent cannot start Chromium, so it can reach one that
          // runs outside the sandbox.
          ...(process.env.PLAYWRIGHT_WS
            ? {
                provider: playwright({
                  connectOptions: { wsEndpoint: process.env.PLAYWRIGHT_WS },
                  contextOptions: { locale: 'en-US' },
                }),
              }
            : {}),
        },
        {
          browser: 'firefox',
          provider: playwright({
            contextOptions: { locale: 'en-US' },
            launchOptions: {
              firefoxUserPrefs: {
                'network.cookie.cookieBehavior': 5,
                'network.cookie.cookieBehavior.pbmode': 5,
              },
            },
          }),
          include: [
            'app/lib/usercontent-delivery.behavior.browser.test.tsx',
            'app/lib/*anchor*.behavior.browser.test.tsx',
            'app/lib/csp-reporter.behavior.browser.test.tsx',
            'app/lib/pdf-viewer.behavior.browser.test.tsx',
            'app/lib/video-viewer.behavior.browser.test.tsx',
            'app/lib/preview-security.behavior.browser.test.tsx',
            'app/routes/comment-frame-recovery.behavior.browser.test.tsx',
            'app/routes/sandbox-frame-recovery.behavior.browser.test.tsx',
            'app/routes/a.$id/viewer-revisit.behavior.browser.test.tsx',
            'app/routes/a.$id/hash-sync.behavior.browser.test.tsx',
          ],
        },
        {
          browser: 'webkit',
          include: [
            'app/lib/usercontent-delivery.behavior.browser.test.tsx',
            'app/lib/*anchor*.behavior.browser.test.tsx',
            'app/lib/csp-reporter.behavior.browser.test.tsx',
            'app/lib/pdf-viewer.behavior.browser.test.tsx',
            'app/lib/video-viewer.behavior.browser.test.tsx',
            'app/lib/preview-security.behavior.browser.test.tsx',
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
