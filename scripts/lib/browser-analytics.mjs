export const analyticsHostPattern =
  /^https:\/\/([a-z0-9-]+\.)*(google-analytics\.com|googletagmanager\.com)\//u

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
