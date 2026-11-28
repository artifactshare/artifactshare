import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteLoaderData,
} from 'react-router'
import { env } from 'cloudflare:workers'

import type { Route } from './+types/root'
import { useEffect } from 'react'
import './app.css'
import { useErrorDocument } from '~/lib/error-document'
import { BrandMark } from '~/components/app/brand-mark'
import { guideFocusRingRoundedClassName } from '~/components/app/guide-styles'
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '~/components/ui/empty'
import { documentLocale } from '~/lib/document-locale.server'
import { MESSAGES } from '~/i18n/messages'
import { sandboxBlockReportMiddleware } from '~/middleware/sandbox-block-report.server'
import { sessionMiddleware } from '~/middleware/auth'
import { linkDomainContext, userContext } from '~/middleware/context'
import { Toaster } from '~/components/ui/sonner'
import { TooltipProvider } from '~/components/ui/tooltip'
import { getAppTheme } from '~/lib/app-theme.server'
import { DEFAULT_APP_THEME, type AppTheme } from '~/lib/app-theme'
import { isMaintenanceRequest } from '~/lib/maintenance'
import { readLastLoginMethod } from '~/lib/auth-cookies'
import { resolveAnalyticsConsent } from '~/lib/analytics-consent'
import { getAnalyticsConsent } from '~/lib/analytics-consent.server'
import { AnalyticsConsentBanner } from '~/components/app/analytics-consent-banner'
import { AnalyticsConsentProvider } from '~/components/app/analytics-consent-provider'
import { AnalyticsGtag } from '~/components/app/analytics-gtag'
import { AnalyticsSignupTracker } from '~/components/app/analytics-signup-tracker'
import { AnalyticsAuthTracker } from '~/components/app/analytics-auth-tracker'
import { ViewerTimezone } from '~/components/app/viewer-timezone'
import { RenderClockProvider } from '~/components/app/render-clock'
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
import { countReceivedAccessRequests } from '~/services/access-requests.server'
import { linkViewerHistoryUrl } from '~/lib/link-viewer-history'
export { shouldRevalidate } from '~/lib/root-locale'

const PROJECT_TIMEZONE_ROUTE_IDS = new Set([
  'routes/_protected/projects.$id',
  'routes/_protected/projects.$id.activity',
])

export function isProjectTimezoneRoute(
  matches: ReadonlyArray<{ id: string }>,
): boolean {
  return matches.some((match) => PROJECT_TIMEZONE_ROUTE_IDS.has(match.id))
}

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

export const middleware = [sandboxBlockReportMiddleware, sessionMiddleware]

export async function loader({ request, url, context }: Route.LoaderArgs) {
  const linkDomainState = context.get(linkDomainContext)
  const linkDomain = linkDomainState !== null
  const linkViewerPath = linkDomainState
    ? `/a/${linkDomainState.shareableId}`
    : null
  const user = context.get(userContext)
  const locale = documentLocale(request, { url, user, linkDomain })
  const appTheme = getAppTheme(request)
  const notice = user ? await getLatestVisibleNotice() : undefined
  const noticeState = readUpdatesNotice(request)
  const updatesNotice = updatesNoticePresentation(noticeState, notice?.slug)
  const accessRequestNotice = user
    ? {
        count: await countReceivedAccessRequests(createDb(), user).catch(
          () => 0,
        ),
      }
    : { count: 0 }
  const analyticsMeasurementId: string | null = env.GA4_MEASUREMENT_ID
    ? env.GA4_MEASUREMENT_ID
    : null
  const analyticsConsent = resolveAnalyticsConsent(
    getAnalyticsConsent(request),
    request.cf?.country as string | undefined,
  )
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
    accessRequestNotice,
    maintenance: isMaintenanceRequest(request),
    lastLoginMethod: readLastLoginMethod(request.headers.get('cookie')),
    analyticsConsent,
    analyticsMeasurementId,
    analyticsUserId,
    analyticsSignup,
    linkDomain,
    linkViewerPath,
    appOrigin: env.BETTER_AUTH_URL,
    renderedAt: nowIso(),
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>('root')
  const { locale, appOrigin } = useErrorDocument(data)
  const appTheme: AppTheme = data?.appTheme ?? DEFAULT_APP_THEME
  const linkViewerPath = data?.linkViewerPath ?? null
  useEffect(() => {
    if (!linkViewerPath) return
    if (window.location.pathname !== linkViewerPath) return
    window.history.replaceState(
      window.history.state,
      '',
      linkViewerHistoryUrl('/', window.location.search, window.location.hash),
    )
  }, [linkViewerPath])
  return (
    <html lang={locale} data-app-origin={appOrigin} data-theme={appTheme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              // oxlint-disable-next-line analytics/typed-sender -- bootstraps the gtag queue that the typed sender writes to
              'window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};',
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        <AnalyticsConsentProvider>
          <TooltipProvider delayDuration={300} disableHoverableContent>
            <RenderClockProvider renderedAt={data?.renderedAt ?? null}>
              {children}
            </RenderClockProvider>
          </TooltipProvider>
          <AnalyticsConsentBanner />
          <Toaster position="bottom-center" theme={appTheme} locale={locale} />
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
          shouldLoadAnalytics={
            data?.analyticsConsent?.shouldLoadAnalytics ?? false
          }
        />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  const matches = useMatches()
  return (
    <>
      <Outlet />
      {isProjectTimezoneRoute(matches) ? <ViewerTimezone /> : null}
    </>
  )
}

export function ErrorBoundary({
  error,
}: Pick<Route.ErrorBoundaryProps, 'error'>) {
  const data = useRouteLoaderData<typeof loader>('root')
  const { locale, appOrigin } = useErrorDocument(data)
  const messages = MESSAGES[locale]
  const kind =
    isRouteErrorResponse(error) && error.status === 404
      ? 'missing'
      : 'unexpected'
  return (
    <main
      data-screen-capture-error="route-error-boundary"
      className="flex min-h-dvh flex-col p-4"
    >
      <a
        href={appOrigin ? new URL('/', appOrigin).href : '/'}
        aria-label={messages['vw.homeLink']}
        className={`inline-flex items-center gap-2 self-start font-semibold ${guideFocusRingRoundedClassName}`}
      >
        <BrandMark size={16} aria-hidden="true" />
        Artifact Share
      </a>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>{messages[`root.error.${kind}.title`]}</h1>
          </EmptyTitle>
          <EmptyDescription>
            {messages[`root.error.${kind}.description`]}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  )
}
