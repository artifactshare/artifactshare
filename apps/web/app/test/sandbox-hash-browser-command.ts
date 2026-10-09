import { defineBrowserCommand } from '@vitest/browser-playwright'

const fixtureOrigin = 'https://sandbox.example.com'
const fixturePattern = `${fixtureOrigin}/**`
const loads = new WeakMap<object, number>()

// Fulfill artifact documents locally, with a one-use delivery token when the
// fixture models signed-in delivery. No fixture request reaches the network.
export const sandboxHashDocument = defineBrowserCommand(
  async ({ page }, html: string, signedIn: boolean) => {
    await page.unroute(fixturePattern)
    const spent = new Set<string>()
    loads.set(page, 0)
    await page.route(fixturePattern, async (route) => {
      const url = route.request().url()
      loads.set(page, (loads.get(page) ?? 0) + 1)
      if (signedIn && spent.has(url)) {
        await route.fulfill({
          status: 403,
          body: 'Delivery token already used',
        })
        return
      }
      spent.add(url)
      await route.fulfill({ contentType: 'text/html', body: html })
    })
    return `${fixtureOrigin}/index.html${signedIn ? '?t=synthetic-token' : ''}`
  },
)

export const sandboxHashDocumentLoads = defineBrowserCommand(({ page }) =>
  Promise.resolve(loads.get(page) ?? 0),
)

declare module 'vitest/browser' {
  interface BrowserCommands {
    sandboxHashDocument: (html: string, signedIn: boolean) => Promise<string>
    sandboxHashDocumentLoads: () => Promise<number>
  }
}
