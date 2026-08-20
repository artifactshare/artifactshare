import { Stack } from '~/components/layout/stack'
import { authProviderButtonClassName } from './auth-styles'
import { GoogleMark } from './google-mark'
import { MicrosoftMark } from './microsoft-mark'
import { LastUsedBadge } from './last-used-badge'
import { Button } from '~/components/ui/button'
import { useRouteLoaderData } from 'react-router'
import { useT } from '~/hooks/use-t'
import { signIn } from '~/lib/auth-client'
import { ANALYTICS_EVENTS, ANALYTICS_PARAMS } from '~/lib/analytics/events'
import { trackEvent } from '~/lib/analytics/track.client'
import { captureAuthAttempt } from '~/lib/analytics/auth-attempt.client'

/**
 * Provider sign-in buttons (Google / Microsoft), full-width and stacked.
 * Shared by the landing hero, the dedicated /sign-in page, and the shared-file
 * pre-auth screen so every pre-login surface offers the same providers.
 *
 * `callbackURL` is where the provider returns after auth. When omitted the
 * current page is used (resolved at click time so SSR has no window dependency).
 */
export function SignInOptions({
  callbackURL,
  disabled,
  regressionPrimary,
  errorCallbackURL,
}: {
  callbackURL?: string
  disabled?: boolean
  regressionPrimary?: string
  errorCallbackURL?: string
}) {
  const { t } = useT()
  const root = useRouteLoaderData<{
    analyticsConsent?: { shouldLoadAnalytics: boolean }
  }>('root')

  const resolveCallback = () =>
    callbackURL ??
    (typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : '/')

  const startSignIn = (provider: 'google' | 'microsoft') => {
    const callback = resolveCallback()
    trackEvent(ANALYTICS_EVENTS.signUpStart, {
      [ANALYTICS_PARAMS.method]: provider,
    })
    captureAuthAttempt({
      method: provider,
      callbackURL: callback,
      shouldLoadAnalytics: root?.analyticsConsent?.shouldLoadAnalytics ?? false,
    })
    signIn.social({
      provider,
      callbackURL: callback,
      // On failure better-auth redirects here (else its own /api/auth/error,
      // which in prod bounces to the landing page) and appends ?error= / &error=.
      // Carry the destination as `next` so the email-code fallback on /sign-in
      // still returns the user to the file or authorize flow they started from.
      errorCallbackURL:
        errorCallbackURL ?? `/sign-in?next=${encodeURIComponent(callback)}`,
    })
  }

  return (
    <Stack gap="2">
      <Button
        type="button"
        variant="outline"
        className={authProviderButtonClassName}
        onClick={() => startSignIn('google')}
        disabled={disabled}
        data-regression-primary={regressionPrimary}
      >
        <GoogleMark />
        <span>{t('lp.cta')}</span>
        <LastUsedBadge method="google" />
      </Button>
      <Button
        type="button"
        variant="outline"
        className={authProviderButtonClassName}
        onClick={() => startSignIn('microsoft')}
        disabled={disabled}
      >
        <MicrosoftMark />
        <span>{t('signin.ms.cta')}</span>
        <LastUsedBadge method="microsoft" />
      </Button>
    </Stack>
  )
}
