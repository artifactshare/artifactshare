import { defineBrowserCommand } from '@vitest/browser-playwright'
import type { CspViolationMessage } from '@artifactshare/viewer-kit/csp-reporter'
import { artifactContentSecurityPolicy } from '../../workers/lib/artifact-response'

type DiagnosticResult = {
  reports: CspViolationMessage[]
  errors: string[]
  unexpectedRequests: string[]
  sandboxOrigin: string
}

export const cspDiagnostic = defineBrowserCommand(
  async ({ page }, html: string) => {
    const context = await page.context().browser()!.newContext()
    const sandboxOrigin = 'https://sandbox.example.com'
    const viewerOrigin = 'https://example.com'
    const errors: string[] = []
    const unexpectedRequests: string[] = []
    try {
      // Fulfill both documents locally. No fixture request may reach the network.
      await context.route('**/*', async (route) => {
        const url = route.request().url()
        if (url === `${viewerOrigin}/viewer`) {
          await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><link rel="icon" href="data:,"><iframe src="${sandboxOrigin}/artifact.html"></iframe>`,
          })
        } else if (url === `${sandboxOrigin}/artifact.html`) {
          await route.fulfill({
            contentType: 'text/html',
            headers: {
              'Content-Security-Policy': artifactContentSecurityPolicy(
                'html',
                viewerOrigin,
              ),
            },
            body: html,
          })
        } else {
          unexpectedRequests.push(url)
          await route.abort()
        }
      })
      const viewer = await context.newPage()
      viewer.on('pageerror', (error) => errors.push(error.message))
      await viewer.goto(`${viewerOrigin}/viewer`, { timeout: 3000 })
      // Model a server-rendered viewer whose JS hydrates after the iframe has
      // finished parsing. No parent listener or ready-check exists before load.
      await viewer.evaluate((origin) => {
        const reports: CspViolationMessage[] = []
        Object.assign(window, { reports })
        window.addEventListener('message', (event) => {
          if (
            event.origin === origin &&
            event.source === document.querySelector('iframe')!.contentWindow &&
            event.data?.kind === 'csp-violation'
          )
            reports.push(event.data)
        })
        document.querySelector('iframe')!.contentWindow!.postMessage(
          {
            source: 'artifactshare-parent',
            kind: 'ready-check',
            challenge: 'synthetic-challenge',
          },
          origin,
        )
      }, sandboxOrigin)
      await viewer.waitForFunction(
        () => (window as unknown as { reports: unknown[] }).reports.length > 0,
        undefined,
        { timeout: 3000 },
      )
      const reports = await viewer.evaluate(
        () => (window as unknown as { reports: CspViolationMessage[] }).reports,
      )
      return { reports, errors, unexpectedRequests, sandboxOrigin }
    } finally {
      await context.close()
    }
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    cspDiagnostic: (html: string) => Promise<DiagnosticResult>
  }
}
