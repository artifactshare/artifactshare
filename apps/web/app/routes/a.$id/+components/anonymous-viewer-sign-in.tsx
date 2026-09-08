import { useRouteLoaderData } from 'react-router'
import { Button } from '~/components/ui/button'
import type { AnalyticsConsentResolution } from '~/lib/analytics-consent'

const className =
  'text-foreground hover:bg-accent border-border bg-card h-8 rounded-[var(--r-md)] px-3 text-sm font-medium'

export function AnonymousViewerSignInControl({
  href,
  label,
  shouldLoadAnalytics,
}: {
  href: string
  label: string
  shouldLoadAnalytics: boolean
}) {
  if (shouldLoadAnalytics) {
    return (
      <Button asChild variant="outline" size="default" className={className}>
        <a href={href}>{label}</a>
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="default"
      className={className}
      // A previously loaded Google linker can keep decorating anchors after
      // consent is withdrawn, so navigate without exposing an href to it.
      onClick={() => window.location.assign(href)}
    >
      {label}
    </Button>
  )
}

export function AnonymousViewerSignIn({
  href,
  label,
}: {
  href: string
  label: string
}) {
  const rootData = useRouteLoaderData<{
    analyticsConsent?: AnalyticsConsentResolution
  }>('root')

  return (
    <AnonymousViewerSignInControl
      href={href}
      label={label}
      shouldLoadAnalytics={
        rootData?.analyticsConsent?.shouldLoadAnalytics ?? false
      }
    />
  )
}
