import {
  exportPdfObservation,
  exportPdfDiagnostics,
  inspectExportPdf,
  probeExportPdfBoundary,
  stallExportPdfFonts,
  printExportPdfWithKeyboard,
} from './app/test/export-pdf-browser-command'
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
      name: 'pdf-export-http-fixture',
      configureServer(server) {
        const receipts = new Map<
          string,
          {
            receipt: number
            url: string
            method: string
            cookie: string
            referrer: string
          }[]
        >()
        let nextReceipt = 0
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://localhost')
          if (url.pathname === '/__pdf_receipts') {
            const id = url.searchParams.get('id') ?? ''
            const records = receipts.get(id) ?? []
            if (request.method === 'DELETE') receipts.delete(id)
            response.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            response.end(JSON.stringify(records))
            return
          }
          if (url.pathname.startsWith('/__pdf_probe')) {
            const cookie = request.headers.cookie ?? ''
            // Route dispatch tags direct probes; real redirect responses carry
            // the same session in Location, even when credentials are omitted.
            const id =
              url.searchParams.get('pdf_probe_id') ??
              request.headers['x-pdf-probe-id'] ??
              /(?:^|; )pdf_probe_id=([^;]+)/.exec(cookie)?.[1]
            if (typeof id === 'string') {
              const records = receipts.get(id) ?? []
              records.push({
                receipt: ++nextReceipt,
                url: new URL(request.url!, `http://${request.headers.host}`)
                  .href,
                method: request.method ?? 'GET',
                cookie,
                referrer: request.headers.referer ?? '',
              })
              receipts.set(id, records)
            }
            response.writeHead(200, {
              'content-type': 'text/plain',
              'cache-control': 'no-store',
            })
            response.end()
            return
          }
          if (
            url.pathname !==
            '/api/shareables/artifact-1/export-asset/redirect.png'
          )
            return next()
          response.writeHead(302, {
            location: `/__pdf_probe_redirect?pdf_probe_id=${encodeURIComponent(String(request.headers['x-pdf-probe-id'] ?? ''))}`,
            'cache-control': 'no-store',
          })
          response.end()
        })
      },
    },
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
        exportPdfObservation,
        exportPdfDiagnostics,
        inspectExportPdf,
        probeExportPdfBoundary,
        stallExportPdfFonts,
        printExportPdfWithKeyboard,
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
            'app/routes/a.$id/export-pdf.behavior.browser.test.tsx',
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
            'app/routes/a.$id/export-pdf.behavior.browser.test.tsx',
          ],
        },
      ],
      fileParallelism: false,
    },
  },
})
