import { defineBrowserCommand } from '@vitest/browser-playwright'

const siteOrigin = 'https://a-abc123def4--v-7632.usercontent.localhost:5174'

// Serve a synthetic static site locally: exact files, or index.html for
// extensionless routes when the fixture falls back to index. No request
// reaches the network.
export const staticSiteCommentSite = defineBrowserCommand(
  async ({ page }, files: Record<string, string>, fallbackToIndex: boolean) => {
    await page.unroute(`${siteOrigin}/**`)
    await page.route(`${siteOrigin}/**`, async (route) => {
      const url = new URL(route.request().url())
      // A renewed entry URL continues to its validated destination.
      const next = url.searchParams.get('as_next')
      if (url.searchParams.has('__as_token') && next?.startsWith('/')) {
        await route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><script>location.replace(${JSON.stringify(next)})</script>`,
        })
        return
      }
      const pathname = decodeURIComponent(url.pathname)
      const path = pathname === '/' ? '/index.html' : pathname
      const body =
        files[path] ??
        (fallbackToIndex && !/\.[^./]+$/.test(path)
          ? files['/index.html']
          : undefined)
      await route.fulfill(
        body === undefined
          ? { status: 404, body: 'Missing' }
          : { contentType: 'text/html', body },
      )
    })
    return siteOrigin
  },
)

// Act inside the cross-origin artifact frame (#anchor-reporter): a trusted
// click, or an expression whose serializable result is returned.
// Remove this targeted diagnostic after the intermittent failure is localized.
let staticSiteFrameCall = 0
export const staticSiteFrame = defineBrowserCommand(
  async ({ frame }, action: { click?: string; evaluate?: string }) => {
    const call = ++staticSiteFrameCall
    const kind = action.click ? 'click' : 'evaluate'
    const started = performance.now()
    const debug = process.env.DEBUG?.includes('pw:browser')
    let phase = 'entry'
    const trace = (next: string) => {
      phase = next
      if (debug) {
        console.error(
          `[staticSiteFrame] call=${call} operation=${kind} phase=${phase} elapsedMs=${Math.round(performance.now() - started)}`,
        )
      }
    }
    trace('entry')
    try {
      trace('resolve-test-frame')
      const testFrame = await frame()
      trace('resolve-artifact-element')
      const handle = await testFrame.$('#anchor-reporter')
      trace('resolve-artifact-frame')
      const artifact = await handle?.contentFrame()
      if (!artifact) throw new Error('Static-site frame is not available')
      trace('action-start')
      if (action.click) {
        await artifact.click(action.click)
        trace('complete')
        return null
      }
      const result = (await artifact.evaluate(
        action.evaluate ?? 'null',
      )) as unknown
      trace('complete')
      return result
    } catch (error) {
      trace(`error:${phase}`)
      throw error
    }
  },
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    staticSiteCommentSite: (
      files: Record<string, string>,
      fallbackToIndex: boolean,
    ) => Promise<string>
    staticSiteFrame: (action: {
      click?: string
      evaluate?: string
    }) => Promise<unknown>
  }
}
