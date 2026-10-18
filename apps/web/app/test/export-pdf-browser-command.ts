import { randomUUID } from 'node:crypto'
import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { ConsoleMessage, Page, Request } from 'playwright'

type FixtureAsset = {
  path: string
  mime: string
  body: string
  base64?: boolean
}
type Observation = {
  url: string
  cookie: string
  method: string
  referrer: string
  receipt?: number
  wire?: boolean
}
const sessions = new WeakMap<
  Page,
  {
    receiptId: string
    requests: Observation[]
    externalRequests: Observation[]
    attempts: Observation[]
    errors: string[]
    stopDiagnostics: () => void
    listen: (request: Request) => void
    revoked: boolean
    pending: Promise<unknown>[]
  }
>()

export const exportPdfObservation = defineBrowserCommand(
  async (
    { page },
    action:
      | 'start'
      | 'read'
      | 'attempts'
      | 'external'
      | 'stop'
      | 'negative'
      | 'revoke',
    source?: unknown,
    assets: FixtureAsset[] = [],
  ) => {
    const context = page.context()
    const origin = new URL(page.url()).origin
    if (action === 'start') {
      const receiptId = randomUUID()
      const requests: Observation[] = []
      const externalRequests: Observation[] = []
      const attempts: Observation[] = []
      const pending: Promise<unknown>[] = []
      const recordRequest = (request: Request, observations: Observation[]) => {
        const observed = {
          url: request.url(),
          cookie: '',
          referrer: '',
          method: request.method(),
        }
        observations.push(observed)
        pending.push(
          request
            .allHeaders()
            .then((headers) => {
              observed.cookie = headers.cookie ?? ''
              observed.referrer = headers.referer ?? ''
            })
            .catch(() => {
              // Missing header evidence must never look like anonymous loading.
              observed.cookie = '[unavailable]'
              observed.referrer = '[unavailable]'
            }),
        )
      }
      const listen = (request: Request) => {
        const url = new URL(request.url())
        if (url.protocol === 'data:') return
        if (url.pathname.startsWith('/__pdf_probe')) {
          // Some engines emit request events even for CSP-blocked attempts.
          // Keep those diagnostics separate from dispatch to the route below.
          recordRequest(request, attempts)
        } else if (
          url.origin === 'https://example.com' &&
          url.pathname.startsWith('/pdf-fixture/')
        ) {
          recordRequest(request, externalRequests)
        } else if (
          url.hostname === 'fonts.gstatic.com' ||
          request.resourceType() === 'font'
        ) {
          recordRequest(request, requests)
        }
      }
      const errors: string[] = []
      const observedPages = new Set<Page>()
      const record = (message: string) => {
        if (errors.length < 20) errors.push(message.slice(0, 500))
      }
      const pageError = (error: Error) => record(error.message)
      const consoleError = (message: ConsoleMessage) => {
        if (message.type() === 'error') record(message.text())
      }
      const watchPage = (popup: Page) => {
        observedPages.add(popup)
        popup.on('pageerror', pageError)
        popup.on('console', consoleError)
      }
      context.on('page', watchPage)
      const stopDiagnostics = () => {
        context.off('page', watchPage)
        for (const popup of observedPages) {
          popup.off('pageerror', pageError)
          popup.off('console', consoleError)
        }
      }
      sessions.set(page, {
        receiptId,
        requests,
        externalRequests,
        attempts,
        listen,
        revoked: false,
        pending,
        errors,
        stopDiagnostics,
      })
      context.on('request', listen)
      await context.addCookies([
        { name: 'pdf_test_session', value: 'synthetic', url: origin },
        { name: 'pdf_probe_id', value: receiptId, url: origin },
        {
          name: 'pdf_test_external',
          value: 'synthetic',
          url: 'https://example.com',
          sameSite: 'None',
          secure: true,
        },
      ])
      await context.route('**/__pdf_probe**', (route) => {
        // Interception is reached only when the browser dispatches a request,
        // unlike its earlier request event. The authenticated negative control
        // must reach this same observer; no probe path is excluded here.
        recordRequest(route.request(), requests)
        return new URL(route.request().url()).origin === origin
          ? route.continue({
              headers: {
                ...route.request().headers(),
                'x-pdf-probe-id': receiptId,
              },
            })
          : route.abort('blockedbyclient')
      })
      await context.route(
        '**/api/shareables/artifact-1/export-source**',
        (route) =>
          route.fulfill({
            status: sessions.get(page)?.revoked ? 404 : 200,
            json: sessions.get(page)?.revoked
              ? { error: { code: 'not-found' } }
              : source,
            headers: { 'cache-control': 'no-store' },
          }),
      )
      await context.route(
        '**/api/shareables/artifact-1/export-asset**',
        (route) => {
          const url = new URL(route.request().url())
          const path = decodeURIComponent(
            url.pathname.split('/export-asset')[1],
          )
          // WebKit cannot fulfill redirects through request interception.
          // The local Vite fixture serves this real HTTP response instead.
          if (path === '/redirect.png')
            return route.continue({
              headers: {
                ...route.request().headers(),
                'x-pdf-probe-id': receiptId,
              },
            })
          const file = assets.find((asset) => asset.path === path)
          if (
            !file ||
            url.searchParams.get('versionId') !==
              (source as { versionId: string }).versionId
          )
            return route.fulfill({ status: 404, body: '' })
          return route.fulfill({
            body: file.base64 ? Buffer.from(file.body, 'base64') : file.body,
            contentType: file.mime,
            headers: { 'cache-control': 'no-store' },
          })
        },
      )
    }
    if (action === 'start') {
      // Chromium/Firefox support intercepted external redirects. WebKit uses
      // the real HTTP endpoint redirect test and an external acquisition failure.
      // Never let synthetic hosts reach the public network.
      await context.route('https://example.com/pdf-fixture/**', (route) => {
        const file = assets.find(
          (asset) => asset.path === new URL(route.request().url()).pathname,
        )
        if (file)
          return route.fulfill({
            body: file.base64 ? Buffer.from(file.body, 'base64') : file.body,
            contentType: file.mime,
            headers: {
              'access-control-allow-origin': '*',
              'cache-control': 'no-store',
            },
          })
        if (
          route.request().url().endsWith('/redirect') &&
          context.browser()!.browserType().name() !== 'webkit'
        ) {
          return route.fulfill({
            status: 302,
            headers: {
              location: `${origin}/__pdf_probe_external_redirect?pdf_probe_id=${sessions.get(page)!.receiptId}`,
              'access-control-allow-origin': '*',
            },
            body: '',
          })
        }
        return route.abort('failed')
      })
    }
    if (action === 'revoke') {
      const state = sessions.get(page)
      if (state) state.revoked = true
    }
    if (action === 'negative') {
      const unsafe = await context.newPage()
      try {
        await context.route('**/__pdf_negative', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<img src="/__pdf_probe_csp_image"><form method="post" action="/__pdf_probe_negative"><button>Submit</button></form>',
          }),
        )
        await Promise.all([
          unsafe.waitForResponse(`${origin}/__pdf_probe_csp_image`),
          unsafe.goto(`${origin}/__pdf_negative`),
        ])
        await Promise.all([
          unsafe.waitForURL('**/__pdf_probe_negative'),
          unsafe.locator('button').click(),
        ])
      } finally {
        await unsafe.close()
        await context.unroute('**/__pdf_negative')
      }
    }
    const state = sessions.get(page)
    await Promise.all(state?.pending ?? [])
    // Intercepted WebKit headers omit Cookie, and redirect destinations do not
    // dispatch another route handler. Only server receipts establish wire headers.
    if (state) {
      const response = await context.request.get(
        `${origin}/__pdf_receipts?id=${state.receiptId}`,
      )
      if (!response.ok()) throw new Error('PDF request receipts unavailable')
      const receipts: Observation[] = await response.json()
      // A receipt consumes one dispatch at most; rereading must not duplicate
      // it or collapse repeated redirect destinations into the first request.
      for (const receipt of receipts) {
        if (
          state.requests.some((request) => request.receipt === receipt.receipt)
        )
          continue
        receipt.wire = true
        const dispatched = state.requests.find(
          (request) =>
            request.receipt === undefined &&
            request.url === receipt.url &&
            request.method === receipt.method,
        )
        if (dispatched) Object.assign(dispatched, receipt)
        else state.requests.push(receipt)
      }
      if (action === 'stop')
        await context.request.delete(
          `${origin}/__pdf_receipts?id=${state.receiptId}`,
        )
    }
    const result =
      (action === 'external'
        ? state?.externalRequests
        : action === 'attempts'
          ? state?.attempts
          : state?.requests) ?? []
    if (action === 'stop') {
      if (state) context.off('request', state.listen)
      state?.stopDiagnostics()
      sessions.delete(page)
      await context.unroute('**/__pdf_probe**')
      await context.unroute('**/api/shareables/artifact-1/export-source**')
      await context.unroute('**/api/shareables/artifact-1/export-asset**')
      await context.unroute('https://example.com/pdf-fixture/**')
      await context.clearCookies({ name: 'pdf_test_session' })
      await context.clearCookies({ name: 'pdf_probe_id' })
      await context.clearCookies({ name: 'pdf_test_external' })
    }
    return result
  },
)

// Keep startup/CSP failures visible when production cleanup has already removed
// the frame. This is diagnostic evidence, never a substitute for request checks.
export const exportPdfDiagnostics = defineBrowserCommand(
  ({ page }) => sessions.get(page)?.errors ?? [],
)

export const inspectExportPdf = defineBrowserCommand(
  async ({ page }, printLayout = false) => {
    const popup = page.context().pages().at(-1)!
    const frame = popup
      .frames()
      .find((candidate) => candidate.parentFrame() === popup.mainFrame())!
    if (printLayout) await popup.emulateMedia({ media: 'print' })
    try {
      return await frame.evaluate(() => {
        let parentDenied = false
        try {
          void parent.document.cookie
        } catch {
          parentDenied = true
        }
        return {
          parentDenied,
          layoutHeight: Math.max(
            document.body.scrollHeight,
            ...Array.from(document.body.querySelectorAll('*')).map(
              (element) => element.getBoundingClientRect().bottom + scrollY,
            ),
          ),
          origin: self.origin,
          text: document.body.textContent ?? '',
          svgCount: document.querySelectorAll('svg').length,
          svgImages: Array.from(document.querySelectorAll('svg image')).map(
            (image) => ({
              href: image.getAttribute('href'),
              xlinkHref: image.getAttributeNS(
                'http://www.w3.org/1999/xlink',
                'href',
              ),
            }),
          ),
          printFontsLoaded: [400, 700].every((weight) =>
            Array.from(document.fonts).some(
              (font) =>
                font.family === 'ArtifactSharePrintJP' &&
                font.weight === String(weight) &&
                font.status === 'loaded',
            ),
          ),
          fontLoaded: Array.from(document.fonts).some(
            (font) =>
              font.family === 'ExportFixture' && font.status === 'loaded',
          ),
          imageHeights: Array.from(document.images).map(
            (image) => image.naturalHeight,
          ),
          imageLoaded: Array.from(document.images).every(
            (image) => image.naturalWidth > 0,
          ),
          color: getComputedStyle(document.querySelector('h1') ?? document.body)
            .color,
        }
      })
    } finally {
      if (printLayout) await popup.emulateMedia({ media: null })
    }
  },
)

export const probeExportPdfBoundary = defineBrowserCommand(async ({ page }) => {
  const popup = page.context().pages().at(-1)!
  const frame = popup
    .frames()
    .find((candidate) => candidate.parentFrame() === popup.mainFrame())!
  // Use automation only to install markup. Run the attempts through the normal
  // parser under the product's unchanged CSP and sandbox, and require explicit
  // violation events as well as zero dispatched requests.
  const boundaryProbeId = randomUUID()
  const loaded = popup.waitForEvent('framenavigated', {
    predicate: (candidate) => candidate === frame,
    timeout: 5000,
  })
  await popup.evaluate(
    ({ origin, probeId }) => {
      const element = document.querySelector('iframe')!
      const nonce = /script-src 'nonce-([^']+)'/.exec(element.srcdoc)![1]
      const probe = `
      document.body.dataset.probeId = ${JSON.stringify(probeId)};
      document.addEventListener('securitypolicyviolation', (event) => {
        const previous = JSON.parse(document.body.dataset.probeViolations || '[]');
        previous.push(event.effectiveDirective);
        document.body.dataset.probeViolations = JSON.stringify(previous);
      });
      const script = document.createElement('script');
      script.textContent = ${JSON.stringify(`fetch(${JSON.stringify(origin + '/__pdf_probe_nonce')},{method:'POST',credentials:'include'})`)};
      document.body.appendChild(script);
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = ${JSON.stringify(origin + '/__pdf_probe_sandbox_form')};
      document.body.appendChild(form);
      form.submit();
      const image = document.createElement('img');
      image.src = ${JSON.stringify(origin + '/__pdf_probe_csp_image')};
      document.body.appendChild(image);
    `
      const end = element.srcdoc.lastIndexOf('</body>')
      element.srcdoc =
        element.srcdoc.slice(0, end) +
        `<script nonce="${nonce}">${probe}</script>` +
        element.srcdoc.slice(end)
    },
    { origin: new URL(page.url()).origin, probeId: boundaryProbeId },
  )
  await loaded
  // This popup can be backgrounded. Observe parser/CSP state without relying
  // on animation frames from a previously navigated or throttled document.
  await frame
    .waitForFunction(
      (probeId) => {
        if (document.body?.dataset.probeId !== probeId) return false
        const violations: string[] = JSON.parse(
          document.body.dataset.probeViolations ?? '[]',
        )
        return (
          violations.some((directive) => directive.startsWith('script-src')) &&
          violations.includes('img-src')
        )
      },
      boundaryProbeId,
      { timeout: 5000, polling: 50 },
    )
    .catch(async (error: unknown) => {
      const diagnostic = await frame
        .evaluate(() => ({
          readyState: document.readyState,
          probeId: document.body?.dataset.probeId,
          violations: document.body?.dataset.probeViolations,
        }))
        .catch(() => ({ readyState: 'unavailable' }))
      throw new Error(
        `PDF boundary probe ${boundaryProbeId}: ${JSON.stringify(diagnostic)}`,
        { cause: error },
      )
    })
})

export const stallExportPdfFonts = defineBrowserCommand(async ({ page }) => {
  const popup = page.context().pages().at(-1)!
  const frame = popup
    .frames()
    .find((candidate) => candidate.parentFrame() === popup.mainFrame())!
  await frame.evaluate(() =>
    Object.defineProperty(document.fonts, 'ready', {
      get: () => new Promise(() => {}),
    }),
  )
})

export const printExportPdfWithKeyboard = defineBrowserCommand(
  async ({ page }) => {
    const popup = page.context().pages().at(-1)!
    const button = popup.locator('#artifactshare-print-button')
    await button.focus()
    await button.press('Enter')
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    exportPdfDiagnostics: () => Promise<string[]>
    printExportPdfWithKeyboard: () => Promise<void>
    probeExportPdfBoundary: () => Promise<void>
    stallExportPdfFonts: () => Promise<void>
    inspectExportPdf: (printLayout?: boolean) => Promise<{
      layoutHeight: number
      parentDenied: boolean
      origin: string
      text: string
      svgCount: number
      svgImages: Array<{ href: string | null; xlinkHref: string | null }>
      printFontsLoaded: boolean
      fontLoaded: boolean
      imageHeights: number[]
      imageLoaded: boolean
      color: string
    }>
    exportPdfObservation: (
      action:
        | 'start'
        | 'read'
        | 'attempts'
        | 'external'
        | 'stop'
        | 'negative'
        | 'revoke',
      source?: unknown,
      assets?: FixtureAsset[],
    ) => Promise<Observation[]>
  }
}
