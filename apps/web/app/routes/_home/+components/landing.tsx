import { Link, useRouteLoaderData, useSearchParams } from 'react-router'
import { PublicFooter } from '~/components/app/public-footer'
import { AuthBlock } from '~/components/app/auth-card'
import { BrandMark } from '~/components/app/brand-mark'
import { authEmailLinkClassName } from '~/components/app/auth-styles'
import { LastUsedBadge } from '~/components/app/last-used-badge'
import { LandingHero, LandingShell } from '~/components/app/landing-shell'
import {
  landingBrandClassName,
  landingCrumbMarkClassName,
  landingMaintenanceClassName,
  landingMarkSurfaceClassName,
  landingSubClassName,
  landingTitleClassName,
} from '~/components/app/landing-styles'
import { Stack } from '~/components/layout/stack'
import { SignInOptions } from '~/components/app/sign-in-options'
import { useT } from '~/hooks/use-t'
import { safeInternalNext } from '~/lib/safe-next'
import { LandingPage } from './landing-page'

export function Landing({
  regression,
}: {
  regression?: {
    inviteMode?: boolean
    regions?: { main?: string; hero?: string; footer?: string }
    primary?: string
    instantHero?: boolean
  }
} = {}) {
  const { t } = useT()
  const rootData = useRouteLoaderData('root') as
    | { maintenance?: boolean }
    | undefined
  const maintenance = rootData?.maintenance === true
  const [params] = useSearchParams()
  const next = params.get('next')
  // Any redirect that carries a destination (an invite link or a protected
  // route bouncing a signed-out visitor) keeps the focused sign-in view the
  // old landing had; only cold visits get the marketing page.
  const focusedSignIn = regression?.inviteMode ?? next != null
  const inviteMode = regression?.inviteMode ?? next?.startsWith('/a/') ?? false

  if (!focusedSignIn) {
    return <LandingPage regression={regression} />
  }

  const callbackURL = safeInternalNext(next)
  const signInHref = `/sign-in?method=email${next ? `&next=${encodeURIComponent(next)}` : ''}`

  return (
    <LandingShell data-regression-region={regression?.regions?.main}>
      <LandingHero data-regression-region={regression?.regions?.hero}>
        <div className={landingMarkSurfaceClassName}>
          <BrandMark
            size={32}
            className={landingCrumbMarkClassName}
            aria-hidden="true"
          />
        </div>
        <h1 className={landingBrandClassName}>Artifact Share</h1>
        <p className={landingTitleClassName}>
          {inviteMode ? t('lp.invite.title') : t('signin.title')}
        </p>
        <Stack gap="6">
          <p className={landingSubClassName}>
            {inviteMode ? t('lp.invite.sub') : t('signin.sub')}
          </p>
          <AuthBlock>
            <SignInOptions
              callbackURL={callbackURL}
              disabled={maintenance}
              regressionPrimary={regression?.primary}
            />
            <Link to={signInHref} className={authEmailLinkClassName}>
              {t('signin.email.toggle')}
              <LastUsedBadge method="email" />
            </Link>
          </AuthBlock>
        </Stack>
        {maintenance && (
          <p className={landingMaintenanceClassName}>
            {t('lp.maintenanceAuth')}
          </p>
        )}
      </LandingHero>
      <PublicFooter
        variant="minimal"
        data-regression-region={regression?.regions?.footer}
      />
    </LandingShell>
  )
}
