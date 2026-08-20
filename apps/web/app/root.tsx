import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from 'react-router'
import { env } from 'cloudflare:workers'

import type { Route } from './+types/root'
import './app.css'
import { isPublicPagePath, pathGuideLocale } from '~/lib/guide-locale'
import { getLocale } from '~/lib/i18n.server'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { sessionMiddleware } from '~/middleware/auth'
import { userContext } from '~/middleware/context'
import { Toaster } from '~/components/ui/sonner'
import { TooltipProvider } from '~/components/ui/tooltip'
import { getAppTheme } from '~/lib/app-theme.server'
import { DEFAULT_APP_THEME, type AppTheme } from '~/lib/app-theme'
import { isMaintenanceRequest } from '~/lib/maintenance'
import { readLastLoginMethod } from '~/lib/auth-cookies'
import { hasSafeArtifactInviteNext } from '~/lib/safe-next'
import { resolveAnalyticsConsent } from '~/lib/analytics-consent'
import { getAnalyticsConsent } from '~/lib/analytics-consent.server'
import { AnalyticsConsentBanner } from '~/components/app/analytics-consent-banner'
import { AnalyticsConsentProvider } from '~/components/app/analytics-consent-provider'
import { AnalyticsGtag } from '~/components/app/analytics-gtag'
import { AnalyticsSignupTracker } from '~/components/app/analytics-signup-tracker'
import { AnalyticsAuthTracker } from '~/components/app/analytics-auth-tracker'
import { ViewerTimezone } from '~/components/app/viewer-timezone'
import { createDb } from '~/services/db.server'
import { claimPendingSignup } from '~/services/signup-analytics.server'
import { readFirstTouch } from '~/lib/analytics/first-touch.server'
import { nowIso } from '~/lib/datetime'
import type { AnalyticsSignupPayload } from '~/lib/analytics/signup-payload'
import { hmacSha256Base64Url } from '~/lib/hmac'
import { getLatestVisibleNotice } from '~/services/updates-visibility.server'
import {
  readUpdatesNotice,
  updatesNoticePresentation,
} from '~/lib/updates-notice.server'
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
export { shouldRevalidate } from '~/lib/root-locale'

export const links: Route.LinksFunction = () => [
  { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  { rel: 'alternate', type: 'text/plain', href: '/llms.txt' },
  {
    rel: 'service-desc',
    type: 'application/json',
    href: '/.well-known/agent.json',
  },
]

export const middleware = [sessionMiddleware]

export async function loader({ request, url, context }: Route.LoaderArgs) {
  const user = context.get(userContext)
  const pathname = url.pathname
  const hasSafeNext = hasSafeArtifactInviteNext(url.searchParams.get('next'))
  const forced =
    pathname === '/' && (user || hasSafeNext)
      ? null
      : isPublicPagePath(pathname)
        ? pathGuideLocale(pathname)
        : null
  const locale = forced ?? getLocale(request, user?.locale)
  const appTheme = getAppTheme(request)
  const notice = user ? await getLatestVisibleNotice() : undefined
  const noticeState = readUpdatesNotice(request)
  const updatesNotice = isDevScreenStateRequest(
    request,
    'home/updates-menu-open',
  )
    ? { slug: 'dev-screen-updates-notice', dot: true, new: true }
    : updatesNoticePresentation(noticeState, notice?.slug)
  const analyticsMeasurementId: string | null = env.GA4_MEASUREMENT_ID
    ? env.GA4_MEASUREMENT_ID
    : null
  const analyticsConsent = resolveAnalyticsConsent(
    getAnalyticsConsent(request),
    request.cf?.country as string | undefined,
  )
  // Gate the pseudonymous id on consent, not just its forwarding to gtag: a
  // signed-in visitor who has not granted consent must not receive the value in
  // the loader payload at all (pre-consent in the EU, or after withdrawal).
  const analyticsUserId =
    user && analyticsConsent.shouldLoadAnalytics && env.BETTER_AUTH_SECRET
      ? await hmacSha256Base64Url(env.BETTER_AUTH_SECRET, 'ga4:' + user.id)
      : null
  let analyticsSignup: AnalyticsSignupPayload | null = null
  if (user && analyticsConsent.shouldLoadAnalytics && analyticsMeasurementId) {
    const db = createDb()
    const pendingExists = await db
      .selectFrom('pending_signup_analytics')
      .select('user_id')
      .where('user_id', '=', user.id)
      .where('tracked_at', 'is', null)
      .executeTakeFirst()
    if (pendingExists) {
      const claimed = await claimPendingSignup(db, user.id, { now: nowIso() })
      if (claimed) {
        analyticsSignup = {
          method: claimed.method,
          workspaceCreated: claimed.workspace_created === 1,
          firstTouch: readFirstTouch(request),
        }
      }
    }
  }
  return {
    locale,
    user,
    appTheme,
    updatesNotice,
    maintenance: isMaintenanceRequest(request),
    lastLoginMethod: readLastLoginMethod(request.headers.get('cookie')),
    analyticsConsent,
    analyticsMeasurementId,
    analyticsUserId,
    analyticsSignup,
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>('root')
  const locale: Locale = data?.locale ?? DEFAULT_LOCALE
  const appTheme: AppTheme = data?.appTheme ?? DEFAULT_APP_THEME
  return (
    <html lang={locale} data-theme={appTheme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              'window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};',
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        <AnalyticsConsentProvider>
          <TooltipProvider delayDuration={300} disableHoverableContent>
            {children}
          </TooltipProvider>
          <AnalyticsConsentBanner />
          <Toaster position="bottom-center" theme={appTheme} />
        </AnalyticsConsentProvider>
        <AnalyticsGtag
          shouldLoadAnalytics={
            data?.analyticsConsent?.shouldLoadAnalytics ?? false
          }
          measurementId={data?.analyticsMeasurementId ?? null}
          userId={data?.analyticsUserId ?? null}
        />
        <AnalyticsSignupTracker signup={data?.analyticsSignup ?? null} />
        <AnalyticsAuthTracker
          authenticated={Boolean(data?.user)}
          signup={data?.analyticsSignup ?? null}
        />
        <ViewerTimezone />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!'
  let details = 'An unexpected error occurred.'
  let stack: string | undefined

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error'
    details =
      error.status === 404
        ? 'The requested page could not be found.'
        : error.statusText || details
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message
    stack = error.stack
  }

  return (
    <main
      data-screen-capture-error="route-error-boundary"
      className="mx-auto w-full max-w-5xl p-4 pt-16"
    >
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  )
}
