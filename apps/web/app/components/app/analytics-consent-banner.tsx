import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, useFetcher, useRouteLoaderData } from 'react-router'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import type { AnalyticsConsentResolution } from '~/lib/analytics-consent'
import { withLang } from '~/lib/connect-link'
import { cn } from '~/lib/utils'
import { useAnalyticsConsent } from './analytics-consent-provider'

export function AnalyticsConsentBanner() {
  const { t, locale } = useT()
  const rootData = useRouteLoaderData<{
    analyticsConsent?: AnalyticsConsentResolution
  }>('root')
  const { manualOpen, commentPanelOpen, closeBanner, returnFocus } =
    useAnalyticsConsent()
  const fetcher = useFetcher()
  const bannerRef = useRef<HTMLDivElement>(null)
  const submittedRef = useRef(false)
  const visible =
    (rootData?.analyticsConsent?.showBanner ?? false) || manualOpen
  const submitting = fetcher.state !== 'idle'

  useLayoutEffect(() => {
    const element = bannerRef.current
    if (!element) return
    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--consent-banner-height',
        `${element.offsetHeight}px`,
      )
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    return () => {
      observer.disconnect()
      document.documentElement.style.setProperty(
        '--consent-banner-height',
        '0px',
      )
    }
  }, [commentPanelOpen, visible])

  // Close (and restore focus) only after a choice submitted from THIS banner
  // settles. The root-level fetcher is shared for the whole SPA session, so its
  // `data` stays truthy after the first submission; keying off a per-open
  // submitted flag avoids closing the banner the instant it is re-opened.
  useEffect(() => {
    if (fetcher.state === 'idle' && submittedRef.current) {
      submittedRef.current = false
      closeBanner()
      returnFocus()
    }
  }, [closeBanner, fetcher.state, returnFocus])

  if (!visible) return null

  const decide = (consent: 'granted' | 'denied') => {
    submittedRef.current = true
    fetcher.submit(
      { consent },
      { method: 'POST', action: '/set-analytics-consent' },
    )
  }

  return (
    <div
      ref={bannerRef}
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-0 z-[var(--z-consent-banner)] p-3',
        commentPanelOpen && 'max-sheet:hidden',
      )}
    >
      <Alert
        role="region"
        aria-label={t('analyticsConsent.banner.aria')}
        className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-3 shadow-[var(--shadow-lg)] sm:flex-row sm:items-center"
      >
        <AlertDescription className="flex-1">
          {t('analyticsConsent.banner.body')}{' '}
          <Link
            to={withLang('/privacy', locale)}
            className="text-link hover:text-link-hover"
          >
            {t('analyticsConsent.banner.privacyLink')}
          </Link>
        </AlertDescription>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={submitting}
            onClick={() => decide('denied')}
          >
            {t('analyticsConsent.banner.decline')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={submitting}
            onClick={() => decide('granted')}
          >
            {t('analyticsConsent.banner.accept')}
          </Button>
        </div>
      </Alert>
    </div>
  )
}
