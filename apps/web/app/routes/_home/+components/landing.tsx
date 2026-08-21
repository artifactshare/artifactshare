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
  }
} = {}) {
  const { t } = useT()
  const rootData = useRouteLoaderData('root') as
    | { maintenance?: boolean }
    | undefined
  const maintenance = rootData?.maintenance === true
  const [params] = useSearchParams()
  const next = params.get('next')
  const inviteMode = regression?.inviteMode ?? next?.startsWith('/a/') ?? false

  // Invite links keep the focused sign-in view; everyone else gets the
  // marketing landing page, which sends sign-in through /sign-in.
  if (!inviteMode) {
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
        <p className={landingTitleClassName}>{t('lp.invite.title')}</p>
        <Stack gap="6">
          <p className={landingSubClassName}>{t('lp.invite.sub')}</p>
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
