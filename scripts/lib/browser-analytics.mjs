// The app's pages load the analytics tag, which posts to Google hosts. A
// browser check of the app does not verify analytics, so it answers those
// requests locally: its result must not depend on external DNS or network
// access (a resolver or firewall that blocks the hosts would otherwise turn
// the refused request into a browser console error).
export const analyticsHostPattern =
  /^https:\/\/([a-z0-9-]+\.)*(google-analytics\.com|googletagmanager\.com)\//u

/** Answer analytics requests from a Playwright browser context locally. */
export function answerAnalyticsLocally(context) {
  return context.route(analyticsHostPattern, (route) =>
    route.fulfill(
      new URL(route.request().url()).hostname.endsWith('googletagmanager.com')
        ? { status: 200, contentType: 'text/javascript', body: '' }
        : { status: 204, body: '' },
    ),
  )
}
