// The app's pages load the analytics tag, which posts to Google hosts. A
// browser check or capture of the app does not verify analytics, so it answers
// those requests locally: its result and its readiness waits (network idle)
// must not depend on external DNS, network access or Google's response time.
export const analyticsHostPattern =
  /^https:\/\/([a-z0-9-]+\.)*(google-analytics\.com|googletagmanager\.com)\//u

/**
 * Open a Playwright browser context for the app whose analytics requests are
 * answered locally. Scripts open app contexts only through this function;
 * scripts/browser-analytics.test.mjs fails on a direct newContext call in
 * scripts, apps/web/scripts or any package scripts folder, at any depth.
 */
export async function newAppBrowserContext(browser, options) {
  const context = await browser.newContext(options)
  try {
    await context.route(analyticsHostPattern, (route) =>
      route.fulfill(
        new URL(route.request().url()).hostname.endsWith('googletagmanager.com')
          ? { status: 200, contentType: 'text/javascript', body: '' }
          : { status: 204, body: '' },
      ),
    )
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
  return context
}
